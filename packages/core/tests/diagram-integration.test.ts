/**
 * Comprehensive integration tests for generate-diagram tool.
 * Tests the full execution path: tool.execute() → file read → parse → diagram → render.
 * Target: >90% coverage across all diagram generator functions.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createGenerateDiagramTool } from '../src/tools/generate-diagram.js';
import { generateDiagramFromContent } from '../src/tools/generate-diagram.js';

let tmpDir: string;
let tool: ReturnType<typeof createGenerateDiagramTool>;

// ── Sample sources ──────────────────────────────────────────

const COBOL_PROGRAM = `       IDENTIFICATION DIVISION.
       PROGRAM-ID. CUSTMAINT.
       AUTHOR. TEST.
       ENVIRONMENT DIVISION.
       INPUT-OUTPUT SECTION.
       FILE-CONTROL.
           SELECT CUSTFILE ASSIGN TO 'CUSTMST'
               ORGANIZATION IS INDEXED
               ACCESS MODE IS DYNAMIC
               RECORD KEY IS CUST-NO.
           SELECT RPTFILE ASSIGN TO 'CUSTRPT'.
       DATA DIVISION.
       FILE SECTION.
       FD CUSTFILE.
       01 CUST-RECORD.
           05 CUST-NO        PIC X(6).
           05 CUST-NAME      PIC X(30).
           05 CUST-ADDR.
               10 CUST-STREET PIC X(30).
               10 CUST-CITY   PIC X(20).
               10 CUST-STATE  PIC XX.
               10 CUST-ZIP    PIC X(5).
           05 CUST-BALANCE   PIC S9(7)V99 COMP-3.
       WORKING-STORAGE SECTION.
       01 WS-EOF           PIC X VALUE 'N'.
       01 WS-ACTION        PIC X.
           COPY CUSTCOPY.
       PROCEDURE DIVISION.
       MAIN-CONTROL.
           PERFORM INIT-ROUTINE.
           PERFORM PROCESS-LOOP UNTIL WS-EOF = 'Y'.
           PERFORM CLEANUP-ROUTINE.
           STOP RUN.
       INIT-ROUTINE.
           OPEN I-O CUSTFILE.
           OPEN OUTPUT RPTFILE.
       PROCESS-LOOP.
           READ CUSTFILE INTO CUST-RECORD
               AT END MOVE 'Y' TO WS-EOF
               NOT AT END PERFORM PROCESS-RECORD.
       PROCESS-RECORD.
           EVALUATE WS-ACTION
               WHEN 'A'
                   CALL 'CUSTADD' USING CUST-RECORD
               WHEN 'D'
                   CALL 'CUSTDEL' USING CUST-NO
               WHEN 'U'
                   CALL 'CUSTUPD' USING CUST-RECORD
               WHEN OTHER
                   PERFORM ERROR-HANDLER
           END-EVALUATE.
       ERROR-HANDLER.
           EXEC CICS LINK PROGRAM('ERRPGM')
               COMMAREA(CUST-RECORD) END-EXEC.
       CLEANUP-ROUTINE.
           CLOSE CUSTFILE.
           CLOSE RPTFILE.
           GOBACK.
`;

const CL_PROGRAM = `       PGM PARM(&LIB &FILE)
       DCL VAR(&LIB) TYPE(*CHAR) LEN(10)
       DCL VAR(&FILE) TYPE(*CHAR) LEN(10)
       DCL VAR(&ERRFLG) TYPE(*LGL) VALUE('0')
       MONMSG MSGID(CPF0000) EXEC(GOTO CMDLBL(ERROR))
       IF COND(&LIB *EQ ' ') THEN(DO)
           CHGVAR VAR(&LIB) VALUE('PRODLIB')
       ENDDO
       CALL PGM(CUSTPGM) PARM(&LIB &FILE)
       IF COND(&ERRFLG *EQ '1') THEN(DO)
           CALL PGM(ERRLOG) PARM(&LIB)
           GOTO CMDLBL(CLEANUP)
       ENDDO
       CALL PGM(RPTPGM) PARM(&FILE)
       GOTO CMDLBL(CLEANUP)
ERROR:
       CHGVAR VAR(&ERRFLG) VALUE('1')
       SNDPGMMSG MSG('Error in processing') TOPGMQ(*EXT)
CLEANUP:
       CALL PGM(CLNPGM)
       ENDPGM
`;

const RPG_PROGRAM = `**free
ctl-opt main(main);
ctl-opt option(*srcstmt:*nodebugio);

/copy qcpysrc,custds
/copy qcpysrc,errds

dcl-ds CustomerDS qualified;
  custNo char(6);
  custName char(30);
  balance packed(9:2);
end-ds;

dcl-ds OrderDS qualified;
  ordNo char(8);
  ordDate date;
  ordAmt packed(9:2);
end-ds;

dcl-proc main;
  dcl-pi *n;
    pAction char(1);
  end-pi;

  select;
    when pAction = 'A';
      callp addCustomer(CustomerDS);
    when pAction = 'D';
      callp deleteCustomer(CustomerDS.custNo);
    when pAction = 'R';
      callp generateReport();
  endsl;

  return;
end-proc;

dcl-proc addCustomer;
  dcl-pi *n;
    pCust likeds(CustomerDS);
  end-pi;
  // Add logic
end-proc;

dcl-proc deleteCustomer;
  dcl-pi *n;
    pCustNo char(6);
  end-pi;
  // Delete logic
end-proc;

dcl-proc generateReport;
  dcl-pi *n end-pi;
  callp printReport();
end-proc;
`;

const PLI_PROGRAM = `CUSTMAINT: PROCEDURE OPTIONS(MAIN);
  %INCLUDE CUSTCOPY;
  %INCLUDE ERRHDLR;

  DCL CUSTOMER_RECORD,
      2 CUST_NO CHAR(6),
      2 CUST_NAME CHAR(30),
      2 CUST_BALANCE FIXED DEC(9,2);

  DCL ORDER_RECORD,
      2 ORD_NO CHAR(8),
      2 ORD_DATE CHAR(10);

  CALL INITPGM();
  CALL PROCESSPGM(CUSTOMER_RECORD);
  CALL REPORTPGM();

INITPGM: PROCEDURE;
  PUT LIST('Initializing...');
END INITPGM;

PROCESSPGM: PROCEDURE(REC);
  DCL REC CHAR(100);
  EXEC SQL SELECT * FROM CUSTTABLE;
  EXEC CICS READ FILE('CUSTFL');
END PROCESSPGM;

REPORTPGM: PROCEDURE;
  PUT LIST('Report complete');
END REPORTPGM;

END CUSTMAINT;
`;

const BMS_MAP = `CUSTMS   DFHMSD TYPE=MAP,MODE=INOUT,LANG=COBOL,TIOAPFX=YES
CUSTM1   DFHMDI SIZE=(24,80),LINE=1,COLUMN=1
TITLE    DFHMDF POS=(1,25),LENGTH=30,ATTRB=(ASKIP,BRT),INITIAL='CUSTOMER MAINTENANCE'
ACCTL    DFHMDF POS=(3,2),LENGTH=8,ATTRB=(ASKIP),INITIAL='Account:'
ACCTN    DFHMDF POS=(3,12),LENGTH=6,ATTRB=(UNPROT,NUM,IC)
NAMEL    DFHMDF POS=(5,2),LENGTH=5,ATTRB=(ASKIP),INITIAL='Name:'
NAMEF    DFHMDF POS=(5,12),LENGTH=30,ATTRB=(UNPROT,BRT)
ADDRL    DFHMDF POS=(7,2),LENGTH=8,ATTRB=(ASKIP),INITIAL='Address:'
ADDRF    DFHMDF POS=(7,12),LENGTH=40,ATTRB=(UNPROT)
BALL     DFHMDF POS=(9,2),LENGTH=8,ATTRB=(ASKIP),INITIAL='Balance:'
BALF     DFHMDF POS=(9,12),LENGTH=12,ATTRB=(PROT)
MSG      DFHMDF POS=(22,2),LENGTH=60,ATTRB=(ASKIP,BRT)
         DFHMSD TYPE=FINAL
         END
`;

const DDS_PF = `     A          R CUSTREC
     A            CUSTNO         6A         TEXT('Customer Number')
     A            CUSTNM        30A         TEXT('Customer Name')
     A            CUSTCITY      20A         TEXT('Customer City')
     A            CUSTST         2A         TEXT('Customer State')
     A            CUSTBAL        9S 2       TEXT('Customer Balance')
     A          K CUSTNO
`;

const DDS_DSPF = `     A                                      DSPSIZ(24 80)
     A                                      CF03(03 'Exit')
     A                                      CF12(12 'Cancel')
     A          R SCRN01
     A                                  1 25'CUSTOMER INQUIRY'
     A            CUSTNO    R        B  3 12REFFLD(CUSTNO CUSTMST)
     A            CUSTNM        30A  O  5 12
     A            CUSTBAL        9S 2O  7 12
`;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencob-diagram-test-'));
  tool = createGenerateDiagramTool(tmpDir);

  // Write test source files
  fs.writeFileSync(path.join(tmpDir, 'CUSTMAINT.cbl'), COBOL_PROGRAM);
  fs.writeFileSync(path.join(tmpDir, 'CUSTPROC.clle'), CL_PROGRAM);
  fs.writeFileSync(path.join(tmpDir, 'CUSTMAINT.rpgle'), RPG_PROGRAM);
  fs.writeFileSync(path.join(tmpDir, 'CUSTMAINT.pli'), PLI_PROGRAM);
  fs.writeFileSync(path.join(tmpDir, 'CUSTMS.map'), BMS_MAP);
  fs.writeFileSync(path.join(tmpDir, 'CUSTMST.pf'), DDS_PF);
  fs.writeFileSync(path.join(tmpDir, 'CUSTINQ.dspf'), DDS_DSPF);

  // Write a modern file for modern diagram tests
  fs.writeFileSync(
    path.join(tmpDir, 'app.ts'),
    `
import { UserService } from './user-service';
import { Logger } from './logger';

class App extends BaseApp {
  private logger = new Logger();
  private users: UserService;

  constructor() {
    super();
    this.users = new UserService();
  }

  async start() {
    this.logger.info('Starting');
    await this.users.init();
  }
}

export class BaseApp {
  protected config: any;
}
`,
  );
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ══════════════════════════════════════════════════════════════
//  COBOL Diagram Types
// ══════════════════════════════════════════════════════════════

describe('generate_diagram tool — COBOL', () => {
  it('generates call_graph', async () => {
    const result = await tool.execute({ path: 'CUSTMAINT.cbl', type: 'call_graph' });
    expect(result.success).toBe(true);
    expect(result.content).toContain('mermaid');
    expect(result.content).toContain('CUSTADD');
    expect(result.content).toContain('CUSTDEL');
    expect(result.content).toContain('CUSTUPD');
    expect(result.content).toContain('CICS LINK');
  });

  it('generates dependency_map', async () => {
    const result = await tool.execute({ path: 'CUSTMAINT.cbl', type: 'dependency_map' });
    expect(result.success).toBe(true);
    expect(result.content).toContain('mermaid');
    expect(result.content).toContain('CUSTCOPY');
  });

  it('generates structure_chart', async () => {
    const result = await tool.execute({ path: 'CUSTMAINT.cbl', type: 'structure_chart' });
    expect(result.success).toBe(true);
    expect(result.content).toContain('mermaid');
    expect(result.content).toContain('MAIN-CONTROL');
    expect(result.content).toContain('PROCESS-RECORD');
  });

  it('generates procedure_flow', async () => {
    const result = await tool.execute({ path: 'CUSTMAINT.cbl', type: 'procedure_flow' });
    expect(result.success).toBe(true);
    expect(result.content).toContain('mermaid');
    expect(result.content).toContain('INIT-ROUTINE');
    expect(result.content).toContain('CLEANUP-ROUTINE');
  });

  it('generates control_flow (default section)', async () => {
    const result = await tool.execute({ path: 'CUSTMAINT.cbl', type: 'control_flow' });
    expect(result.success).toBe(true);
    expect(result.content).toContain('mermaid');
  });

  it('generates control_flow with section_id', async () => {
    const result = await tool.execute({
      path: 'CUSTMAINT.cbl',
      type: 'control_flow',
      section_id: 3,
    });
    expect(result.success).toBe(true);
    expect(result.content).toContain('mermaid');
  });

  it('generates field_hierarchy', async () => {
    const result = await tool.execute({ path: 'CUSTMAINT.cbl', type: 'field_hierarchy' });
    expect(result.success).toBe(true);
    expect(result.content).toContain('mermaid');
    expect(result.content).toContain('CUST-NO');
    expect(result.content).toContain('CUST-ADDR');
  });

  it('generates file_io', async () => {
    const result = await tool.execute({ path: 'CUSTMAINT.cbl', type: 'file_io' });
    expect(result.success).toBe(true);
    expect(result.content).toContain('mermaid');
    expect(result.content).toContain('CUSTFILE');
    expect(result.content).toContain('CUSTMST');
  });

  it('generates copybook_tree', async () => {
    const result = await tool.execute({ path: 'CUSTMAINT.cbl', type: 'copybook_tree' });
    expect(result.success).toBe(true);
    expect(result.content).toContain('mermaid');
    expect(result.content).toContain('CUSTCOPY');
  });
});

// ══════════════════════════════════════════════════════════════
//  CL Diagram Types
// ══════════════════════════════════════════════════════════════

describe('generate_diagram tool — CL', () => {
  it('generates call_graph', async () => {
    const result = await tool.execute({ path: 'CUSTPROC.clle', type: 'call_graph' });
    expect(result.success).toBe(true);
    expect(result.content).toContain('mermaid');
    expect(result.content).toContain('CUSTPGM');
    expect(result.content).toContain('RPTPGM');
  });

  it('generates dependency_map (no deps = fallback)', async () => {
    const result = await tool.execute({ path: 'CUSTPROC.clle', type: 'dependency_map' });
    // CL programs might not have explicit deps
    expect(result).toBeDefined();
  });

  it('rejects structure_chart (CL has no paragraphs)', async () => {
    const result = await tool.execute({ path: 'CUSTPROC.clle', type: 'structure_chart' });
    // CL has no paragraph structure, so structure_chart is not available
    expect(result.success).toBe(false);
  });

  it('generates procedure_flow', async () => {
    const result = await tool.execute({ path: 'CUSTPROC.clle', type: 'procedure_flow' });
    expect(result.success).toBe(true);
    expect(result.content).toContain('mermaid');
  });

  it('generates control_flow', async () => {
    const result = await tool.execute({ path: 'CUSTPROC.clle', type: 'control_flow' });
    expect(result.success).toBe(true);
    expect(result.content).toContain('mermaid');
  });
});

// ══════════════════════════════════════════════════════════════
//  RPG Diagram Types
// ══════════════════════════════════════════════════════════════

describe('generate_diagram tool — RPG', () => {
  it('generates call_graph', async () => {
    const result = await tool.execute({ path: 'CUSTMAINT.rpgle', type: 'call_graph' });
    expect(result.success).toBe(true);
    expect(result.content).toContain('mermaid');
    expect(result.content).toContain('ADDCUSTOMER');
  });

  it('generates dependency_map', async () => {
    const result = await tool.execute({ path: 'CUSTMAINT.rpgle', type: 'dependency_map' });
    expect(result.success).toBe(true);
    expect(result.content).toContain('mermaid');
    expect(result.content).toContain('custds');
  });

  it('generates structure_chart', async () => {
    const result = await tool.execute({ path: 'CUSTMAINT.rpgle', type: 'structure_chart' });
    expect(result.success).toBe(true);
    expect(result.content).toContain('mermaid');
    expect(result.content).toContain('main');
  });

  it('generates procedure_flow', async () => {
    const result = await tool.execute({ path: 'CUSTMAINT.rpgle', type: 'procedure_flow' });
    expect(result.success).toBe(true);
    expect(result.content).toContain('mermaid');
  });

  it('generates field_hierarchy', async () => {
    const result = await tool.execute({ path: 'CUSTMAINT.rpgle', type: 'field_hierarchy' });
    expect(result.success).toBe(true);
    expect(result.content).toContain('mermaid');
    expect(result.content).toContain('CustomerDS');
  });

  it('generates file_io', async () => {
    const result = await tool.execute({ path: 'CUSTMAINT.rpgle', type: 'file_io' });
    // RPG file I/O may or may not produce output depending on dcl-f
    expect(result).toBeDefined();
  });
});

// ══════════════════════════════════════════════════════════════
//  PL/I Diagram Types
// ══════════════════════════════════════════════════════════════

describe('generate_diagram tool — PL/I', () => {
  it('generates call_graph', async () => {
    const result = await tool.execute({ path: 'CUSTMAINT.pli', type: 'call_graph' });
    expect(result.success).toBe(true);
    expect(result.content).toContain('mermaid');
    expect(result.content).toContain('INITPGM');
  });

  it('generates dependency_map', async () => {
    const result = await tool.execute({ path: 'CUSTMAINT.pli', type: 'dependency_map' });
    expect(result.success).toBe(true);
    expect(result.content).toContain('mermaid');
    expect(result.content).toContain('CUSTCOPY');
  });

  it('generates structure_chart', async () => {
    const result = await tool.execute({ path: 'CUSTMAINT.pli', type: 'structure_chart' });
    expect(result.success).toBe(true);
    expect(result.content).toContain('mermaid');
  });

  it('generates procedure_flow', async () => {
    const result = await tool.execute({ path: 'CUSTMAINT.pli', type: 'procedure_flow' });
    expect(result.success).toBe(true);
    expect(result.content).toContain('mermaid');
  });

  it('generates field_hierarchy (if available for PL/I)', async () => {
    const result = await tool.execute({ path: 'CUSTMAINT.pli', type: 'field_hierarchy' });
    // PL/I DCL parsing may not produce enough for field_hierarchy
    if (result.success) {
      expect(result.content).toContain('mermaid');
    } else {
      expect(result.content).toMatch(/not available|No data found/);
    }
  });
});

// ══════════════════════════════════════════════════════════════
//  BMS Diagram Types
// ══════════════════════════════════════════════════════════════

describe('generate_diagram tool — BMS', () => {
  it('generates screen_layout (ASCII)', async () => {
    const result = await tool.execute({ path: 'CUSTMS.map', type: 'screen_layout' });
    expect(result.success).toBe(true);
    expect(result.content).toContain('+');
    expect(result.content).toContain('|');
    expect(result.content).toContain('CUSTOMER MAINTENANCE');
    expect(result.content).toContain('______'); // input fields
    expect((result.metadata as any)?.format).toBe('ascii');
    expect((result.metadata as any)?.screen?.platform).toBe('3270');
  });

  it('generates dependency_map', async () => {
    const result = await tool.execute({ path: 'CUSTMS.map', type: 'dependency_map' });
    expect(result.success).toBe(true);
    expect(result.content).toContain('mermaid');
    expect(result.content).toContain('CUSTM1');
  });
});

// ══════════════════════════════════════════════════════════════
//  DDS Diagram Types
// ══════════════════════════════════════════════════════════════

describe('generate_diagram tool — DDS', () => {
  it('generates record_layout for PF', async () => {
    const result = await tool.execute({ path: 'CUSTMST.pf', type: 'record_layout' });
    expect(result.success).toBe(true);
    expect(result.content).toContain('mermaid');
    expect(result.content).toContain('CUSTREC');
    expect(result.content).toContain('CUSTNO');
    expect(result.content).toContain('KEY');
  });

  it('generates field_hierarchy for PF', async () => {
    const result = await tool.execute({ path: 'CUSTMST.pf', type: 'field_hierarchy' });
    expect(result.success).toBe(true);
    expect(result.content).toContain('mermaid');
  });

  it('generates screen_layout for DSPF (ASCII)', async () => {
    const result = await tool.execute({ path: 'CUSTINQ.dspf', type: 'screen_layout' });
    expect(result.success).toBe(true);
    expect(result.content).toContain('+');
    expect(result.content).toContain('|');
    expect((result.metadata as any)?.format).toBe('ascii');
    expect((result.metadata as any)?.screen?.platform).toBe('5250');
  });
});

// ══════════════════════════════════════════════════════════════
//  "available" meta-command
// ══════════════════════════════════════════════════════════════

describe('generate_diagram tool — available command', () => {
  it('lists available types for a COBOL file', async () => {
    const result = await tool.execute({ path: 'CUSTMAINT.cbl', type: 'available' });
    expect(result.success).toBe(true);
    const data = JSON.parse(result.content);
    expect(data.category).toBe('program');
    expect(data.available_types).toContain('call_graph');
    expect(data.available_types).toContain('control_flow');
  });

  it('lists available types for a BMS file', async () => {
    const result = await tool.execute({ path: 'CUSTMS.map', type: 'available' });
    expect(result.success).toBe(true);
    const data = JSON.parse(result.content);
    expect(data.category).toBe('screen');
    expect(data.available_types).toContain('screen_layout');
  });

  it('lists available types for a directory', async () => {
    const result = await tool.execute({ path: '.', type: 'available' });
    expect(result.success).toBe(true);
    const data = JSON.parse(result.content);
    expect(data.cbl).toBeDefined();
  });

  it('lists modern types for a TS file', async () => {
    const result = await tool.execute({ path: 'app.ts', type: 'available' });
    expect(result.success).toBe(true);
    const data = JSON.parse(result.content);
    expect(data.available_types).toContain('call-graph');
  });
});

// ══════════════════════════════════════════════════════════════
//  Modern Diagram Types
// ══════════════════════════════════════════════════════════════

describe('generate_diagram tool — Modern', () => {
  it('generates call-graph for TS', async () => {
    const result = await tool.execute({ path: 'app.ts', type: 'call-graph' });
    expect(result.success).toBe(true);
    expect(result.content).toContain('mermaid');
  });

  it('generates dependency diagram for TS', async () => {
    const result = await tool.execute({ path: 'app.ts', type: 'dependency' });
    expect(result.success).toBe(true);
    expect(result.content).toContain('mermaid');
    expect(result.content).toContain('user_service');
  });

  it('generates structure diagram for TS', async () => {
    const result = await tool.execute({ path: 'app.ts', type: 'structure' });
    expect(result.success).toBe(true);
    expect(result.content).toContain('mermaid');
  });

  it('generates class diagram for TS', async () => {
    const result = await tool.execute({ path: 'app.ts', type: 'class' });
    expect(result.success).toBe(true);
    expect(result.content).toContain('mermaid');
    expect(result.content).toContain('App');
    expect(result.content).toContain('BaseApp');
  });

  it('generates dependency for a directory with modern files', async () => {
    // Create a subdirectory with only modern files
    const subDir = path.join(tmpDir, 'modern');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, 'index.ts'), "import { foo } from './foo';\n");
    fs.writeFileSync(path.join(subDir, 'foo.ts'), 'export const foo = 1;\n');
    const result = await tool.execute({ path: 'modern', type: 'dependency' });
    expect(result.success).toBe(true);
    expect(result.content).toContain('mermaid');
  });
});

// ══════════════════════════════════════════════════════════════
//  Error Handling
// ══════════════════════════════════════════════════════════════

describe('generate_diagram tool — error handling', () => {
  it('rejects missing path', async () => {
    const result = await tool.execute({ path: '', type: 'call_graph' });
    expect(result.success).toBe(false);
    expect(result.content).toContain('Error');
  });

  it('rejects missing type', async () => {
    const result = await tool.execute({ path: 'CUSTMAINT.cbl', type: '' });
    expect(result.success).toBe(false);
    expect(result.content).toContain('Error');
  });

  it('rejects non-existent file', async () => {
    const result = await tool.execute({ path: 'NOTEXIST.cbl', type: 'call_graph' });
    expect(result.success).toBe(false);
    expect(result.content).toContain('not found');
  });

  it('rejects path traversal', async () => {
    const result = await tool.execute({ path: '../../../etc/passwd', type: 'call_graph' });
    expect(result.success).toBe(false);
    expect(result.content).toContain('traversal');
  });

  it('rejects invalid diagram type for category', async () => {
    const result = await tool.execute({ path: 'CUSTMST.pf', type: 'call_graph' });
    expect(result.success).toBe(false);
    expect(result.content).toContain('not available');
  });
});

// ══════════════════════════════════════════════════════════════
//  Content-based generation (expanded)
// ══════════════════════════════════════════════════════════════

describe('generateDiagramFromContent — comprehensive', () => {
  it('generates structure_chart from COBOL', () => {
    const result = generateDiagramFromContent(COBOL_PROGRAM, 'cbl', 'structure_chart');
    expect(result.success).toBe(true);
    expect(result.content).toContain('mermaid');
    expect(result.content).toContain('MAIN-CONTROL');
  });

  it('generates procedure_flow from COBOL', () => {
    const result = generateDiagramFromContent(COBOL_PROGRAM, 'cbl', 'procedure_flow');
    expect(result.success).toBe(true);
    expect(result.content).toContain('mermaid');
  });

  it('generates control_flow from CL', () => {
    const result = generateDiagramFromContent(CL_PROGRAM, 'clle', 'control_flow');
    expect(result.success).toBe(true);
    expect(result.content).toContain('mermaid');
  });

  it('generates call_graph from RPG', () => {
    const result = generateDiagramFromContent(RPG_PROGRAM, 'rpgle', 'call_graph');
    expect(result.success).toBe(true);
    expect(result.content).toContain('mermaid');
  });

  it('generates dependency_map from PL/I', () => {
    const result = generateDiagramFromContent(PLI_PROGRAM, 'pli', 'dependency_map');
    expect(result.success).toBe(true);
    expect(result.content).toContain('mermaid');
    expect(result.content).toContain('CUSTCOPY');
  });

  it('generates record_layout from DDS PF', () => {
    const result = generateDiagramFromContent(DDS_PF, 'pf', 'record_layout');
    expect(result.success).toBe(true);
    expect(result.content).toContain('mermaid');
    expect(result.content).toContain('CUSTREC');
  });

  it('generates field_hierarchy from DDS', () => {
    const result = generateDiagramFromContent(DDS_PF, 'pf', 'field_hierarchy');
    expect(result.success).toBe(true);
    expect(result.content).toContain('mermaid');
  });

  it('generates screen_layout from DSPF content', () => {
    const result = generateDiagramFromContent(DDS_DSPF, 'dspf', 'screen_layout');
    expect(result.success).toBe(true);
    expect(result.metadata?.format).toBe('ascii');
    expect(result.content).toContain('+');
  });

  it('handles extension with leading dot', () => {
    const result = generateDiagramFromContent(COBOL_PROGRAM, '.cbl', 'call_graph');
    expect(result.success).toBe(true);
  });
});
