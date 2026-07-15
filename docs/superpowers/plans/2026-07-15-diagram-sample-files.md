# Diagram Sample Files Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bundle 15 payment-domain sample source files into the OpenCob VS Code extension VSIX so users can immediately test diagram generation after install.

**Architecture:** Sample files live in `packages/extension/resources/samples/` (automatically bundled in the VSIX because `.vscodeignore` does not exclude `resources/`). A new `OpenCob.openSamples` command adds the samples folder to the workspace. A VS Code walkthrough surfaces this command on first install.

**Tech Stack:** TypeScript (VS Code extension API), legacy language file formats (COBOL/RPG/PL/I/CL/DDS/BMS/JCL/REXX/NATURAL/HLASM), modern languages (TypeScript/Python/Java/Go), Vitest for integration tests.

## Global Constraints

- Node >= 22, pnpm >= 10, VS Code >= 1.100.0
- All commands follow existing naming convention: `OpenCob.commandName` (capital O, capital C)
- No new npm dependencies
- All sample files use payment/banking domain content
- Run `pnpm --filter opencob test` after each task to verify tests pass
- Run `pnpm lint && pnpm build` before final commit

---

## File Structure

```
CREATE packages/extension/tests/diagram-samples.test.ts   — integration tests for all samples
CREATE packages/extension/resources/samples/PAYTRANS.cbl
CREATE packages/extension/resources/samples/PAYAUTH.rpgle
CREATE packages/extension/resources/samples/SETTLMNT.pli
CREATE packages/extension/resources/samples/RUNPAY.clle
CREATE packages/extension/resources/samples/TRANSACT.pf
CREATE packages/extension/resources/samples/PAYINQ.dspf
CREATE packages/extension/resources/samples/PAYMAP.map
CREATE packages/extension/resources/samples/SETTLJOB.jcl
CREATE packages/extension/resources/samples/PAYRPT.rexx
CREATE packages/extension/resources/samples/PAYBATCH.nsp
CREATE packages/extension/resources/samples/PAYENC.hlasm
CREATE packages/extension/resources/samples/payment-service.ts
CREATE packages/extension/resources/samples/reconcile.py
CREATE packages/extension/resources/samples/PaymentProcessor.java
CREATE packages/extension/resources/samples/gateway.go
MODIFY packages/extension/package.json                    — add command + walkthrough
MODIFY packages/extension/src/extension.ts                — register OpenCob.openSamples
```

---

### Task 1: Test scaffold

**Files:**

- Create: `packages/extension/tests/diagram-samples.test.ts`

**Interfaces:**

- Consumes: `generateDiagramFromContent(content, ext, type)` from `@opencob/core` — returns `{ success: boolean; content: string }`
- Produces: test suite that all subsequent tasks must satisfy

- [ ] **Step 1: Create the test file**

```typescript
// packages/extension/tests/diagram-samples.test.ts
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { generateDiagramFromContent } from '@opencob/core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const samplesDir = join(__dirname, '..', 'resources', 'samples');

const EXPECTED_SAMPLES: Array<{ file: string; ext: string; diagramType: string }> = [
  { file: 'PAYTRANS.cbl', ext: 'cbl', diagramType: 'call_graph' },
  { file: 'PAYAUTH.rpgle', ext: 'rpgle', diagramType: 'call_graph' },
  { file: 'SETTLMNT.pli', ext: 'pli', diagramType: 'call_graph' },
  { file: 'RUNPAY.clle', ext: 'clle', diagramType: 'dependency_map' },
  { file: 'TRANSACT.pf', ext: 'pf', diagramType: 'record_layout' },
  { file: 'PAYINQ.dspf', ext: 'dspf', diagramType: 'screen_layout' },
  { file: 'PAYMAP.map', ext: 'map', diagramType: 'screen_layout' },
  { file: 'SETTLJOB.jcl', ext: 'jcl', diagramType: 'dependency_map' },
  { file: 'PAYRPT.rexx', ext: 'rexx', diagramType: 'control_flow' },
  { file: 'PAYBATCH.nsp', ext: 'nsp', diagramType: 'call_graph' },
  { file: 'PAYENC.hlasm', ext: 'hlasm', diagramType: 'control_flow' },
  { file: 'payment-service.ts', ext: 'ts', diagramType: 'class' },
  { file: 'reconcile.py', ext: 'py', diagramType: 'call-graph' },
  { file: 'PaymentProcessor.java', ext: 'java', diagramType: 'class' },
  { file: 'gateway.go', ext: 'go', diagramType: 'call-graph' },
];

describe('diagram sample files', () => {
  for (const { file, ext, diagramType } of EXPECTED_SAMPLES) {
    it(`${file} exists and renders ${diagramType} without error`, () => {
      const filePath = join(samplesDir, file);
      expect(existsSync(filePath), `${file} missing from resources/samples/`).toBe(true);

      const content = readFileSync(filePath, 'utf-8');
      expect(content.length, `${file} is empty`).toBeGreaterThan(50);

      const result = generateDiagramFromContent(content, ext, diagramType as any);
      expect(result.success, `${file} diagram failed: ${result.content}`).toBe(true);
      expect(result.content.length).toBeGreaterThan(0);
    });
  }
});
```

- [ ] **Step 2: Run tests — expect ALL 15 to fail (files missing)**

```
pnpm --filter opencob test -- tests/diagram-samples.test.ts
```

Expected: 15 failures — `PAYTRANS.cbl missing from resources/samples/`, etc.

- [ ] **Step 3: Commit the failing test scaffold**

```bash
git add packages/extension/tests/diagram-samples.test.ts
git commit -m "test(extension): add failing scaffold for diagram sample files"
```

---

### Task 2: COBOL sample — PAYTRANS.cbl

**Files:**

- Create: `packages/extension/resources/samples/PAYTRANS.cbl`

**Interfaces:**

- Produces: COBOL source that satisfies `generateDiagramFromContent(content, 'cbl', 'call_graph').success === true`

- [ ] **Step 1: Create the file**

```cobol
       IDENTIFICATION DIVISION.
       PROGRAM-ID. PAYTRANS.
       AUTHOR. PAYTECH.
      *=============================================================*
      * PAYTRANS - BATCH PAYMENT TRANSACTION PROCESSOR              *
      * Reads daily transaction file, validates, calculates fees,   *
      * and writes to payment log.                                  *
      *=============================================================*
       ENVIRONMENT DIVISION.
       INPUT-OUTPUT SECTION.
       FILE-CONTROL.
           SELECT TRANSACT-FILE ASSIGN TO 'QTXLIB/TRANSACT'
               ORGANIZATION IS SEQUENTIAL.
           SELECT PAYMENT-LOG   ASSIGN TO 'QTXLIB/PAYLOG'
               ORGANIZATION IS SEQUENTIAL.
       DATA DIVISION.
       FILE SECTION.
       FD  TRANSACT-FILE.
       01  TRANS-RECORD.
           05  TR-TRANS-ID        PIC X(10).
           05  TR-ACCOUNT-NO      PIC X(16).
           05  TR-AMOUNT          PIC S9(9)V99 COMP-3.
           05  TR-TRANS-TYPE      PIC X.
               88  TR-PAYMENT     VALUE 'P'.
               88  TR-REFUND      VALUE 'R'.
               88  TR-TRANSFER    VALUE 'T'.
           05  TR-CURRENCY        PIC X(3).
           05  TR-TIMESTAMP       PIC X(26).
       FD  PAYMENT-LOG.
       01  LOG-RECORD.
           05  LG-TRANS-ID        PIC X(10).
           05  LG-STATUS          PIC X(2).
           05  LG-FEE-AMT         PIC S9(9)V99 COMP-3.
           05  LG-NET-AMT         PIC S9(9)V99 COMP-3.
           05  LG-ERROR-MSG       PIC X(80).
       WORKING-STORAGE SECTION.
           COPY PAYTYPES.
       01  WS-FLAGS.
           05  WS-EOF             PIC X VALUE 'N'.
               88  END-OF-FILE    VALUE 'Y'.
           05  WS-VALID           PIC X VALUE 'N'.
               88  TRANS-VALID    VALUE 'Y'.
       01  WS-COUNTERS.
           05  WS-PROC-COUNT      PIC 9(7) VALUE ZERO.
           05  WS-ERR-COUNT       PIC 9(7) VALUE ZERO.
           05  WS-FEE-TOTAL       PIC S9(11)V99 COMP-3 VALUE ZERO.
       PROCEDURE DIVISION.
       MAIN-PARA.
           PERFORM OPEN-FILES
           PERFORM PROCESS-TRANSACTIONS UNTIL END-OF-FILE
           PERFORM CLOSE-FILES
           STOP RUN.
       OPEN-FILES.
           OPEN INPUT  TRANSACT-FILE
               OUTPUT PAYMENT-LOG.
       PROCESS-TRANSACTIONS.
           READ TRANSACT-FILE
               AT END MOVE 'Y' TO WS-EOF
               NOT AT END
                   PERFORM VALIDATE-TRANS
                   IF TRANS-VALID
                       PERFORM CALC-FEES
                       PERFORM WRITE-LOG
                   ELSE
                       PERFORM LOG-ERROR
                   END-IF
                   ADD 1 TO WS-PROC-COUNT
           END-READ.
       VALIDATE-TRANS.
           MOVE 'Y' TO WS-VALID
           EVALUATE TRUE
               WHEN TR-PAYMENT
                   CALL 'PAYVALID' USING TRANS-RECORD WS-VALID
               WHEN TR-REFUND
                   CALL 'RFDVALID' USING TRANS-RECORD WS-VALID
               WHEN TR-TRANSFER
                   CALL 'XFRVALID' USING TRANS-RECORD WS-VALID
               WHEN OTHER
                   MOVE 'N' TO WS-VALID
           END-EVALUATE.
       CALC-FEES.
           CALL 'FEECALC' USING TR-AMOUNT TR-TRANS-TYPE
                               LG-FEE-AMT LG-NET-AMT
           ADD LG-FEE-AMT TO WS-FEE-TOTAL.
       WRITE-LOG.
           MOVE TR-TRANS-ID TO LG-TRANS-ID
           MOVE 'OK'        TO LG-STATUS
           MOVE SPACES      TO LG-ERROR-MSG
           WRITE LOG-RECORD.
       LOG-ERROR.
           MOVE TR-TRANS-ID   TO LG-TRANS-ID
           MOVE 'ER'          TO LG-STATUS
           MOVE ZEROS         TO LG-FEE-AMT LG-NET-AMT
           MOVE 'VALIDATION FAILED' TO LG-ERROR-MSG
           WRITE LOG-RECORD
           ADD 1 TO WS-ERR-COUNT.
       CLOSE-FILES.
           CLOSE TRANSACT-FILE PAYMENT-LOG.
```

- [ ] **Step 2: Run tests — expect 1 pass (PAYTRANS), 14 still fail**

```
pnpm --filter opencob test -- tests/diagram-samples.test.ts
```

Expected: `PAYTRANS.cbl exists and renders call_graph without error` — PASS

- [ ] **Step 3: Commit**

```bash
git add packages/extension/resources/samples/PAYTRANS.cbl
git commit -m "feat(extension): add COBOL payment transaction sample"
```

---

### Task 3: RPG ILE sample — PAYAUTH.rpgle

**Files:**

- Create: `packages/extension/resources/samples/PAYAUTH.rpgle`

- [ ] **Step 1: Create the file**

```rpg
**FREE
// PAYAUTH - Real-time card authorization
// Validates card, checks daily limit, posts authorization result.

ctl-opt dftactgrp(*no) actgrp('PAYAUTH') option(*srcstmt);

dcl-f CARDMST   disk(*ext) keyed usage(*update);
dcl-f AUTHHIST  disk(*ext) usage(*output);
dcl-f LIMITTBL  disk(*ext) keyed usage(*input);

dcl-ds authRequest qualified;
  cardNo    char(16);
  expiry    char(6);
  amount    packed(13:2);
  currency  char(3);
  merchantId char(15);
end-ds;

dcl-ds cardRec extname('CARDMST') qualified;
end-ds;

dcl-ds authRec extname('AUTHHIST') qualified;
end-ds;

// Entry point: returns auth code on approval, blanks on decline.
dcl-proc authorize export;
  dcl-pi *n;
    request  likeds(authRequest);
    authOut  char(6);
    decFlag  ind;
  end-pi;

  if not validateCard(request.cardNo : request.expiry);
    authOut  = *blanks;
    decFlag  = *on;
    postDecline(request);
    return;
  endif;

  if checkDailyLimit(request.cardNo : request.amount);
    authOut  = *blanks;
    decFlag  = *on;
    postDecline(request);
    return;
  endif;

  authOut  = generateAuthCode(request.cardNo : request.amount);
  decFlag  = *off;
  postApproval(request : authOut);
end-proc;

dcl-proc validateCard;
  dcl-pi *n ind;
    cardNo  char(16);
    expiry  char(6);
  end-pi;

  chain cardNo CARDMST;
  if not %found();
    return *off;
  endif;
  return (cardRec.status = 'A' and cardRec.expiry >= expiry);
end-proc;

dcl-proc checkDailyLimit;
  dcl-pi *n ind;
    cardNo  char(16);
    amount  packed(13:2);
  end-pi;

  chain cardNo LIMITTBL;
  if not %found();
    return *off;
  endif;
  return (cardRec.dailyUsed + amount > cardRec.dailyLimit);
end-proc;

dcl-proc generateAuthCode;
  dcl-pi *n char(6);
    cardNo  char(16);
    amount  packed(13:2);
  end-pi;

  dcl-s seed  packed(20:0);
  seed = %dec(cardNo : 16 : 0) + %dec(%char(amount) : 13 : 0);
  return %char(%rem(seed : 900000) + 100000 : 6);
end-proc;

dcl-proc postApproval;
  dcl-pi *n;
    request  likeds(authRequest);
    authCode char(6);
  end-pi;

  authRec.cardNo   = request.cardNo;
  authRec.amount   = request.amount;
  authRec.authCode = authCode;
  authRec.status   = 'A';
  authRec.tstamp   = %timestamp();
  write AUTHHISTR authRec;
end-proc;

dcl-proc postDecline;
  dcl-pi *n;
    request  likeds(authRequest);
  end-pi;

  authRec.cardNo   = request.cardNo;
  authRec.amount   = request.amount;
  authRec.authCode = *blanks;
  authRec.status   = 'D';
  authRec.tstamp   = %timestamp();
  write AUTHHISTR authRec;
end-proc;
```

- [ ] **Step 2: Run tests**

```
pnpm --filter opencob test -- tests/diagram-samples.test.ts
```

Expected: `PAYAUTH.rpgle exists and renders call_graph without error` — PASS

- [ ] **Step 3: Commit**

```bash
git add packages/extension/resources/samples/PAYAUTH.rpgle
git commit -m "feat(extension): add RPG ILE card authorization sample"
```

---

### Task 4: PL/I sample — SETTLMNT.pli

**Files:**

- Create: `packages/extension/resources/samples/SETTLMNT.pli`

- [ ] **Step 1: Create the file**

```pli
 SETTLMNT: PROCEDURE OPTIONS(MAIN);
 /* ============================================================
  * SETTLMNT - END-OF-DAY SETTLEMENT CALCULATION
  * Reads authorized transactions, groups by merchant,
  * calculates net settlement amounts, writes settlement file.
  * ============================================================ */

 DECLARE 1 TRANS_RECORD,
           2 TR_TRANS_ID    CHAR(10),
           2 TR_MERCHANT    CHAR(15),
           2 TR_AMOUNT      FIXED DEC(11,2),
           2 TR_TRANS_TYPE  CHAR(1),
           2 TR_AUTH_CODE   CHAR(6),
           2 TR_STATUS      CHAR(2);

 DECLARE 1 SETTLE_RECORD,
           2 ST_MERCHANT    CHAR(15),
           2 ST_GROSS       FIXED DEC(13,2),
           2 ST_FEE         FIXED DEC(11,2),
           2 ST_NET         FIXED DEC(13,2),
           2 ST_TXCOUNT     FIXED BIN(31);

 DECLARE TRANS_FILE   FILE RECORD INPUT  SEQUENTIAL ENV(FB BLKSIZE(4000));
 DECLARE SETTLE_FILE  FILE RECORD OUTPUT SEQUENTIAL ENV(FB BLKSIZE(4000));

 DECLARE WS_EOF        BIT(1)        INIT('0'B);
 DECLARE WS_CURR_MERCH CHAR(15)      INIT(' ');
 DECLARE WS_PROC_COUNT FIXED BIN(31) INIT(0);
 DECLARE WS_ERR_COUNT  FIXED BIN(31) INIT(0);
 DECLARE WS_FEE_RATE   FIXED DEC(5,4) INIT(0.0175);

 ON ENDFILE(TRANS_FILE) WS_EOF = '1'B;

 CALL OPEN_FILES;
 CALL INIT_SETTLE_RECORD;
 CALL PROCESS_TRANSACTIONS;
 CALL WRITE_FINAL_SETTLEMENT;
 CALL CLOSE_FILES;

 OPEN_FILES: PROCEDURE;
   OPEN FILE(TRANS_FILE)  TITLE('QTXLIB/AUTHTXN');
   OPEN FILE(SETTLE_FILE) TITLE('QTXLIB/SETTLE');
 END OPEN_FILES;

 PROCESS_TRANSACTIONS: PROCEDURE;
   READ FILE(TRANS_FILE) INTO(TRANS_RECORD);
   DO WHILE(^WS_EOF);
     IF TR_MERCHANT ^= WS_CURR_MERCH & WS_CURR_MERCH ^= ' ' THEN DO;
       CALL WRITE_SETTLEMENT;
       CALL INIT_SETTLE_RECORD;
     END;
     WS_CURR_MERCH = TR_MERCHANT;
     CALL ACCUMULATE_TRANS;
     WS_PROC_COUNT = WS_PROC_COUNT + 1;
     READ FILE(TRANS_FILE) INTO(TRANS_RECORD);
   END;
 END PROCESS_TRANSACTIONS;

 ACCUMULATE_TRANS: PROCEDURE;
   CALL CALC_FEE(TR_AMOUNT, WS_FEE_RATE, ST_FEE);
   ST_MERCHANT = TR_MERCHANT;
   ST_GROSS    = ST_GROSS + TR_AMOUNT;
   ST_NET      = ST_NET + TR_AMOUNT - ST_FEE;
   ST_TXCOUNT  = ST_TXCOUNT + 1;
 END ACCUMULATE_TRANS;

 CALC_FEE: PROCEDURE(P_AMOUNT, P_RATE, P_FEE);
   DECLARE P_AMOUNT FIXED DEC(11,2);
   DECLARE P_RATE   FIXED DEC(5,4);
   DECLARE P_FEE    FIXED DEC(11,2);
   P_FEE = P_AMOUNT * P_RATE;
 END CALC_FEE;

 WRITE_SETTLEMENT: PROCEDURE;
   WRITE FILE(SETTLE_FILE) FROM(SETTLE_RECORD);
 END WRITE_SETTLEMENT;

 WRITE_FINAL_SETTLEMENT: PROCEDURE;
   IF WS_CURR_MERCH ^= ' ' THEN CALL WRITE_SETTLEMENT;
 END WRITE_FINAL_SETTLEMENT;

 INIT_SETTLE_RECORD: PROCEDURE;
   ST_MERCHANT = ' ';
   ST_GROSS    = 0;
   ST_FEE      = 0;
   ST_NET      = 0;
   ST_TXCOUNT  = 0;
 END INIT_SETTLE_RECORD;

 CLOSE_FILES: PROCEDURE;
   CLOSE FILE(TRANS_FILE);
   CLOSE FILE(SETTLE_FILE);
 END CLOSE_FILES;

 END SETTLMNT;
```

- [ ] **Step 2: Run tests**

```
pnpm --filter opencob test -- tests/diagram-samples.test.ts
```

Expected: `SETTLMNT.pli exists and renders call_graph without error` — PASS

- [ ] **Step 3: Commit**

```bash
git add packages/extension/resources/samples/SETTLMNT.pli
git commit -m "feat(extension): add PL/I settlement calculation sample"
```

---

### Task 5: CL ILE sample — RUNPAY.clle

**Files:**

- Create: `packages/extension/resources/samples/RUNPAY.clle`

- [ ] **Step 1: Create the file**

```cl
/************************************************************/
/* RUNPAY - CL ILE JOB CONTROL FOR PAYMENT BATCH RUN       */
/* Submits payment transaction processing jobs in sequence  */
/************************************************************/
PGM

    DCL VAR(&JOBDATE)  TYPE(*CHAR) LEN(8)
    DCL VAR(&RUNENV)   TYPE(*CHAR) LEN(4)  VALUE('PROD')
    DCL VAR(&ERRFLAG)  TYPE(*LGL)          VALUE('0')
    DCL VAR(&MSGID)    TYPE(*CHAR) LEN(7)
    DCL VAR(&MSGDTA)   TYPE(*CHAR) LEN(100)

    /* Get current date */
    RTVSYSVAL SYSVAL(QDATE) RTNVAR(&JOBDATE)

    /* Check environment */
    IF COND(&RUNENV *EQ 'PROD') THEN(DO)
        CALL PGM(ENVCHECK) PARM(&RUNENV &ERRFLAG)
        IF COND(&ERRFLAG *EQ '1') THEN(DO)
            SNDPGMMSG MSG('Environment check failed for PROD run') +
                      MSGTYPE(*ESCAPE)
            GOTO CMDLBL(ENDJOB)
        ENDDO
    ENDDO

    /* Step 1 - Validate transaction input file */
    MONMSG MSGID(CPF0000) EXEC(DO)
        CHGVAR VAR(&ERRFLAG) VALUE('1')
        GOTO CMDLBL(ERRHANDL)
    ENDDO
    CALL PGM(TXNVALID) PARM(&JOBDATE)

    /* Step 2 - Submit authorisation pass */
    SBMJOB JOB(PAYAUTH) JOBD(PAYJOB) PGM(PAYAUTH) +
           PARM(&JOBDATE) INLLIBL(*CURRENT) +
           MSGQ(PAYMSGS)

    /* Wait for PAYAUTH to complete */
    CALL PGM(WAITJOB) PARM('PAYAUTH' '120')

    /* Step 3 - Run settlement calculation */
    SBMJOB JOB(SETTLMNT) JOBD(PAYJOB) PGM(SETTLMNT) +
           PARM(&JOBDATE) INLLIBL(*CURRENT) +
           MSGQ(PAYMSGS)

    CALL PGM(WAITJOB) PARM('SETTLMNT' '180')

    /* Step 4 - Generate payment reports */
    CALL PGM(PAYRPT) PARM(&JOBDATE &RUNENV)

    SNDPGMMSG MSG('Payment batch run completed for ' *CAT &JOBDATE) +
              MSGTYPE(*INFO) TOPGMQ(*EXT)
    GOTO CMDLBL(ENDJOB)

    ERRHANDL:
        SNDPGMMSG MSGID(CPF9898) MSGF(QCPFMSG) +
                  MSGDTA('Payment batch run failed - check PAYMSGS') +
                  MSGTYPE(*ESCAPE)

    ENDJOB:
ENDPGM
```

- [ ] **Step 2: Run tests**

```
pnpm --filter opencob test -- tests/diagram-samples.test.ts
```

Expected: `RUNPAY.clle exists and renders dependency_map without error` — PASS

- [ ] **Step 3: Commit**

```bash
git add packages/extension/resources/samples/RUNPAY.clle
git commit -m "feat(extension): add CL ILE payment batch job control sample"
```

---

### Task 6: DDS Physical File sample — TRANSACT.pf

**Files:**

- Create: `packages/extension/resources/samples/TRANSACT.pf`

- [ ] **Step 1: Create the file**

```dds
     A                                      UNIQUE
     A          R TRANSACTR                 TEXT('Payment Transaction Record')
     A            TRANSID       10A         TEXT('Transaction ID')
     A                                      COLHDG('Transaction' 'ID')
     A            ACCOUNTNO     16A         TEXT('Account Number')
     A                                      COLHDG('Account' 'Number')
     A            CARDNO        16A         TEXT('Card Number')
     A                                      COLHDG('Card' 'Number')
     A            AMOUNT        13P 2       TEXT('Transaction Amount')
     A                                      COLHDG('Amount')
     A            TRANSTYPE      1A         TEXT('Transaction Type P/R/T')
     A                                      COLHDG('Type')
     A            CURRENCY       3A         TEXT('ISO Currency Code')
     A                                      COLHDG('Currency')
     A            MERCHANTID    15A         TEXT('Merchant ID')
     A                                      COLHDG('Merchant' 'ID')
     A            AUTHCODE       6A         TEXT('Authorization Code')
     A                                      COLHDG('Auth' 'Code')
     A            STATUS         2A         TEXT('Status OK/ER/PE')
     A                                      COLHDG('Status')
     A            TSTAMP        26A         TEXT('Timestamp ISO')
     A                                      COLHDG('Timestamp')
     A          K TRANSID
```

- [ ] **Step 2: Run tests**

```
pnpm --filter opencob test -- tests/diagram-samples.test.ts
```

Expected: `TRANSACT.pf exists and renders record_layout without error` — PASS

- [ ] **Step 3: Commit**

```bash
git add packages/extension/resources/samples/TRANSACT.pf
git commit -m "feat(extension): add DDS physical file transaction record sample"
```

---

### Task 7: DDS Display File sample — PAYINQ.dspf

**Files:**

- Create: `packages/extension/resources/samples/PAYINQ.dspf`

- [ ] **Step 1: Create the file**

```dds
     A                                      DSPSIZ(24 80 *DS3)
     A                                      INDARA
     A                                      CA03(03 'Exit')
     A                                      CA12(12 'Cancel')
     A          R HEADER                    TEXT('Screen Header')
     A                                      1  2'OpenCob Payment Inquiry'
     A                                      1 60DATE  EDTCDE(Y)
     A                                      2  2'Account:'
     A            ACCOUNTNO     16A  B  2 11TEXT('Account Number')
     A                                      CHECK(RZ ER)
     A                                      2 30'Press Enter to search'
     A          R PAYDETAIL                 TEXT('Payment Detail')
     A                                      SFL
     A                                      SFLNXTCHG
     A  41                                  SFLDLT
     A            SFLRRN         4S 0H
     A            TRANSID       10A  O  5  2TEXT('Transaction ID')
     A            TRANSTYPE      1A  O  5 14TEXT('Type')
     A            AMOUNT        13Y 2O  5 17TEXT('Amount')
     A                                      EDTCDE(1)
     A            CURRENCY       3A  O  5 32TEXT('Currency')
     A            STATUS         2A  O  5 37TEXT('Status')
     A            TSTAMP        26A  O  5 41TEXT('Timestamp')
     A          R PAYCTL                    TEXT('Subfile Control')
     A                                      SFLCTL(PAYDETAIL)
     A                                      SFLSIZ(0020)
     A                                      SFLPAG(0010)
     A  42                                  SFLDSP
     A  43                                  SFLDSPCTL
     A  44                                  SFLCLR
     A  45                                  SFLEND(*MORE)
     A                                      4  2'Transactions for account:'
     A            DISPACC       16A  O  4 28
     A                                      4 50'F3=Exit  F12=Cancel'
     A                                      23  2'Total records:'
     A            TOTCNT         5S 0O 23 17EDTCDE(Z)
```

- [ ] **Step 2: Run tests**

```
pnpm --filter opencob test -- tests/diagram-samples.test.ts
```

Expected: `PAYINQ.dspf exists and renders screen_layout without error` — PASS

- [ ] **Step 3: Commit**

```bash
git add packages/extension/resources/samples/PAYINQ.dspf
git commit -m "feat(extension): add DDS display file payment inquiry screen sample"
```

---

### Task 8: BMS map sample — PAYMAP.map

**Files:**

- Create: `packages/extension/resources/samples/PAYMAP.map`

- [ ] **Step 1: Create the file**

```bms
PAYMAP   DFHMSD TYPE=MAP,                                              X
               LANG=COBOL,                                             X
               TIOAPFX=YES,                                            X
               STORAGE=AUTO,                                           X
               MODE=INOUT
*
PMHDR    DFHMDI SIZE=(24,80),                                          X
               LINE=1,                                                 X
               COLUMN=1
*
         DFHMDF POS=(01,01),LENGTH=22,ATTRB=(PROT,NORM),              X
               INITIAL='OpenCob Payment Inquiry'
         DFHMDF POS=(01,60),LENGTH=8,ATTRB=(PROT,NORM),               X
               PICOUT='99/99/99'
         DFHMDF POS=(02,01),LENGTH=9,ATTRB=(PROT,NORM),               X
               INITIAL='Account:'
ACCTNO   DFHMDF POS=(02,11),LENGTH=16,ATTRB=(UNPROT,IC),              X
               PICIN='XXXXXXXXXXXXXXXX'
         DFHMDF POS=(02,28),LENGTH=22,ATTRB=(PROT,NORM),              X
               INITIAL='Press Enter to search'
MSGFLD   DFHMDF POS=(24,01),LENGTH=79,ATTRB=(PROT,BRT)
*
PMDETAIL DFHMDI SIZE=(24,80),                                          X
               LINE=5,                                                 X
               COLUMN=1
*
         DFHMDF POS=(05,01),LENGTH=3,ATTRB=(PROT,NORM),               X
               INITIAL='ID:'
TRNID    DFHMDF POS=(05,05),LENGTH=10,ATTRB=(PROT,NORM)
         DFHMDF POS=(05,17),LENGTH=4,ATTRB=(PROT,NORM),               X
               INITIAL='Amt:'
TRNAMT   DFHMDF POS=(05,22),LENGTH=13,ATTRB=(PROT,NORM),              X
               PICOUT='ZZZ,ZZ9.99-'
         DFHMDF POS=(05,36),LENGTH=5,ATTRB=(PROT,NORM),               X
               INITIAL='Curr:'
TRNCCR   DFHMDF POS=(05,42),LENGTH=3,ATTRB=(PROT,NORM)
         DFHMDF POS=(05,47),LENGTH=7,ATTRB=(PROT,NORM),               X
               INITIAL='Status:'
TRNSTS   DFHMDF POS=(05,55),LENGTH=2,ATTRB=(PROT,NORM)
         DFHMDF POS=(23,01),LENGTH=26,ATTRB=(PROT,NORM),              X
               INITIAL='F3=Exit  F9=New  F12=Cancel'
*
         DFHMSD TYPE=FINAL
         END
```

- [ ] **Step 2: Run tests**

```
pnpm --filter opencob test -- tests/diagram-samples.test.ts
```

Expected: `PAYMAP.map exists and renders screen_layout without error` — PASS

- [ ] **Step 3: Commit**

```bash
git add packages/extension/resources/samples/PAYMAP.map
git commit -m "feat(extension): add BMS CICS payment inquiry map sample"
```

---

### Task 9: JCL sample — SETTLJOB.jcl

**Files:**

- Create: `packages/extension/resources/samples/SETTLJOB.jcl`

- [ ] **Step 1: Create the file**

```jcl
//SETTLJOB JOB (PAYTCH,BILLING),'SETTLEMENT BATCH',
//         CLASS=A,MSGCLASS=X,MSGLEVEL=(1,1),
//         NOTIFY=&SYSUID,REGION=0M
//*
//* SETTLJOB - END-OF-DAY SETTLEMENT BATCH
//* Validates auth transactions, calculates settlement,
//* produces merchant payment files and reports.
//*
//JOBLIB  DD  DSN=PAYTCH.PROD.LOADLIB,DISP=SHR
//*
//* STEP 1 - Validate authorized transactions
//TXNVALID EXEC PGM=TXNVALID
//STEPLIB  DD  DSN=PAYTCH.PROD.LOADLIB,DISP=SHR
//AUTHTXN  DD  DSN=PAYTCH.PROD.AUTH.TXNS(&DATE),DISP=SHR
//SYSOUT   DD  SYSOUT=*
//SYSPRINT DD  SYSOUT=*
//*
//* STEP 2 - Run settlement calculation
//SETTLMNT EXEC PGM=SETTLMNT,COND=(0,NE,TXNVALID)
//STEPLIB  DD  DSN=PAYTCH.PROD.LOADLIB,DISP=SHR
//AUTHTXN  DD  DSN=PAYTCH.PROD.AUTH.TXNS(&DATE),DISP=SHR
//SETTLE   DD  DSN=PAYTCH.PROD.SETTLE.(&DATE),
//             DISP=(NEW,CATLG,DELETE),
//             UNIT=SYSDA,SPACE=(TRK,(100,50),RLSE),
//             DCB=(RECFM=FB,LRECL=80,BLKSIZE=4000)
//SYSOUT   DD  SYSOUT=*
//SYSPRINT DD  SYSOUT=*
//*
//* STEP 3 - Generate merchant payment files via PROC
//MERCPAY  EXEC PROC=MERCPAY,
//         DATE=&DATE,
//         ENV=PROD
//*
//* STEP 4 - Settlement summary report
//SETTLRPT EXEC PGM=SETTLEPR,COND=(0,NE)
//STEPLIB  DD  DSN=PAYTCH.PROD.LOADLIB,DISP=SHR
//SETTLE   DD  DSN=PAYTCH.PROD.SETTLE.(&DATE),DISP=SHR
//REPORT   DD  SYSOUT=*,DCB=(RECFM=FBA,LRECL=133)
//SYSPRINT DD  SYSOUT=*
```

- [ ] **Step 2: Run tests**

```
pnpm --filter opencob test -- tests/diagram-samples.test.ts
```

Expected: `SETTLJOB.jcl exists and renders dependency_map without error` — PASS

- [ ] **Step 3: Commit**

```bash
git add packages/extension/resources/samples/SETTLJOB.jcl
git commit -m "feat(extension): add JCL settlement batch job sample"
```

---

### Task 10: REXX sample — PAYRPT.rexx

**Files:**

- Create: `packages/extension/resources/samples/PAYRPT.rexx`

- [ ] **Step 1: Create the file**

```rexx
/* PAYRPT - PAYMENT EXCEPTION REPORT UTILITY              */
/* Scans authorization log, identifies exceptions,        */
/* formats and writes exception report.                   */
ARG RUNDATE OUTFILE .

/* Default to today if no date provided */
IF RUNDATE = '' THEN DO
   RUNDATE = DATE('S')
   SAY 'Using system date:' RUNDATE
END

/* Validate date format YYYYMMDD */
IF LENGTH(RUNDATE) \= 8 | \DATATYPE(RUNDATE, 'N') THEN DO
   SAY 'ERROR: Invalid date format. Use YYYYMMDD.'
   EXIT 8
END

IF OUTFILE = '' THEN
   OUTFILE = 'PAYEXC_' || RUNDATE || '.TXT'

SAY 'Payment Exception Report for:' RUNDATE
SAY 'Output file:' OUTFILE

INFILE = 'QTXLIB/AUTHLOG'
CALL OPENFILE(INFILE)

DECLINED  = 0
OVERLIMIT = 0
INVALID   = 0
TOTALREAD = 0

DO WHILE LINES(INFILE) > 0
   LINE = LINEIN(INFILE)
   TOTALREAD = TOTALREAD + 1

   STATUS    = SUBSTR(LINE, 1, 2)
   TRANSID   = SUBSTR(LINE, 3, 10)
   CARDNO    = SUBSTR(LINE, 13, 16)
   AMOUNT    = STRIP(SUBSTR(LINE, 29, 13))
   REASON    = STRIP(SUBSTR(LINE, 42, 30))

   SELECT
      WHEN STATUS = 'DC' THEN DO
         DECLINED = DECLINED + 1
         CALL WRITELINE(OUTFILE, 'DECLINED  ' TRANSID CARDNO AMOUNT REASON)
      END
      WHEN STATUS = 'OL' THEN DO
         OVERLIMIT = OVERLIMIT + 1
         CALL WRITELINE(OUTFILE, 'OVERLIMIT ' TRANSID CARDNO AMOUNT REASON)
      END
      WHEN STATUS = 'IV' THEN DO
         INVALID = INVALID + 1
         CALL WRITELINE(OUTFILE, 'INVALID   ' TRANSID CARDNO AMOUNT REASON)
      END
      OTHERWISE NOP
   END
END

TOTAL = DECLINED + OVERLIMIT + INVALID
CALL WRITELINE(OUTFILE, COPIES('-', 72))
CALL WRITELINE(OUTFILE, 'Declined:' DECLINED)
CALL WRITELINE(OUTFILE, 'Over limit:' OVERLIMIT)
CALL WRITELINE(OUTFILE, 'Invalid:' INVALID)
CALL WRITELINE(OUTFILE, 'Total exceptions:' TOTAL '/' TOTALREAD)

SAY 'Report complete.' TOTAL 'exceptions from' TOTALREAD 'records.'
EXIT 0

OPENFILE: PROCEDURE
   PARSE ARG FNAME
   IF STREAM(FNAME, 'C', 'OPEN READ') \= 'READY:' THEN DO
      SAY 'ERROR: Cannot open' FNAME
      EXIT 12
   END
RETURN

WRITELINE: PROCEDURE
   PARSE ARG FNAME, TEXT
   LINEOUT(FNAME, TEXT)
RETURN
```

- [ ] **Step 2: Run tests**

```
pnpm --filter opencob test -- tests/diagram-samples.test.ts
```

Expected: `PAYRPT.rexx exists and renders control_flow without error` — PASS

- [ ] **Step 3: Commit**

```bash
git add packages/extension/resources/samples/PAYRPT.rexx
git commit -m "feat(extension): add REXX payment exception report sample"
```

---

### Task 11: NATURAL sample — PAYBATCH.nsp

**Files:**

- Create: `packages/extension/resources/samples/PAYBATCH.nsp`

- [ ] **Step 1: Create the file**

```natural
* PAYBATCH - NATURAL PAYMENT BATCH PROGRAM
* Reads transactions from TRANSACT file, validates,
* accumulates totals by merchant, writes settlement records.
*
DEFINE DATA
  LOCAL
    1 #TRANS-REC
      2 #TRANS-ID        (A10)
      2 #ACCOUNT-NO      (A16)
      2 #AMOUNT          (P13.2)
      2 #TRANS-TYPE      (A1)
      2 #CURRENCY        (A3)
      2 #MERCHANT-ID     (A15)
      2 #STATUS          (A2)
    1 #SETTLE-REC
      2 #MERCH-ID        (A15)
      2 #GROSS           (P15.2)
      2 #FEE             (P13.2)
      2 #NET             (P15.2)
      2 #TX-COUNT        (I4)
    1 #CURR-MERCH        (A15)  INIT<' '>
    1 #FEE-RATE          (P5.4) INIT<0.0175>
    1 #PROC-COUNT        (I7)   INIT<0>
    1 #ERR-COUNT         (I7)   INIT<0>
END-DEFINE
*
OPEN DATASET (001) 'TRANSACT' MODE INPUT
OPEN DATASET (002) 'SETTLE'   MODE OUTPUT
*
CALLNAT 'INITSETL' #SETTLE-REC
*
REPEAT
  READ DATASET (001) #TRANS-REC
  IF *EOF (001)
    ESCAPE BOTTOM
  END-IF
  *
  IF #MERCHANT-ID NE #CURR-MERCH AND #CURR-MERCH NE ' '
    CALLNAT 'WRTSETTL' #SETTLE-REC
    CALLNAT 'INITSETL' #SETTLE-REC
  END-IF
  *
  MOVE #MERCHANT-ID TO #CURR-MERCH
  *
  IF #TRANS-TYPE = 'P' OR = 'T'
    COMPUTE #FEE = #AMOUNT * #FEE-RATE
    ADD #AMOUNT TO #SETTLE-REC.#GROSS
    ADD #FEE    TO #SETTLE-REC.#FEE
    ADD (#AMOUNT - #FEE) TO #SETTLE-REC.#NET
    ADD 1       TO #SETTLE-REC.#TX-COUNT
    ADD 1       TO #PROC-COUNT
  ELSE
    ADD 1 TO #ERR-COUNT
  END-IF
END-REPEAT
*
IF #CURR-MERCH NE ' '
  CALLNAT 'WRTSETTL' #SETTLE-REC
END-IF
*
CLOSE DATASET (001)
CLOSE DATASET (002)
*
WRITE 'Processed:' #PROC-COUNT 'Errors:' #ERR-COUNT
END
```

- [ ] **Step 2: Run tests**

```
pnpm --filter opencob test -- tests/diagram-samples.test.ts
```

Expected: `PAYBATCH.nsp exists and renders call_graph without error` — PASS

- [ ] **Step 3: Commit**

```bash
git add packages/extension/resources/samples/PAYBATCH.nsp
git commit -m "feat(extension): add NATURAL payment batch program sample"
```

---

### Task 12: HLASM sample — PAYENC.hlasm

**Files:**

- Create: `packages/extension/resources/samples/PAYENC.hlasm`

- [ ] **Step 1: Create the file**

```hlasm
*        PAYENC - PIN ENCRYPTION ROUTINE (HLASM)
*        Accepts PIN block and working key, returns
*        encrypted PIN using XOR + DES substitution.
         TITLE 'PAYENC - PIN ENCRYPTION ROUTINE'
PAYENC   CSECT
PAYENC   AMODE 31
PAYENC   RMODE ANY
*
         USING  *,R15
         SAVE   (14,12),,PAYENC_SA
         LR     R12,R15
         DROP   R15
         USING  PAYENC,R12
*
         LA     R13,SAVEAREA
         ST     R13,8(,R14)
*
*        Load parameters
         L      R2,0(,R1)              Address of PIN block (8 bytes)
         L      R3,4(,R1)              Address of working key (8 bytes)
         L      R4,8(,R1)              Address of output buffer (8 bytes)
*
*        XOR PIN block with working key byte by byte
         MVC    PINBUF,0(R2)
         MVC    KEYBUF,0(R3)
*
         LA     R5,PINBUF
         LA     R6,KEYBUF
         LA     R7,8
*
XORLOOP  DS     0H
         XC     0(1,R5),0(R6)
         LA     R5,1(,R5)
         LA     R6,1(,R6)
         BCT    R7,XORLOOP
*
*        Call DES substitution routine
         LA     R1,PARMLIST
         ST     R5,PARMLIST
         ST     R4,PARMLIST+4
         L      R15,=V(DESSUB)
         BALR   R14,R15
*
RETURN   DS     0H
         L      R13,4(,R13)
         RETURN (14,12),,RC=0
*
SAVEAREA DS     18F
PINBUF   DS     D
KEYBUF   DS     D
PARMLIST DS     2A
*
         LTORG
         END    PAYENC
```

- [ ] **Step 2: Run tests**

```
pnpm --filter opencob test -- tests/diagram-samples.test.ts
```

Expected: `PAYENC.hlasm exists and renders control_flow without error` — PASS

- [ ] **Step 3: Commit**

```bash
git add packages/extension/resources/samples/PAYENC.hlasm
git commit -m "feat(extension): add HLASM PIN encryption routine sample"
```

---

### Task 13: Modern language samples

**Files:**

- Create: `packages/extension/resources/samples/payment-service.ts`
- Create: `packages/extension/resources/samples/reconcile.py`
- Create: `packages/extension/resources/samples/PaymentProcessor.java`
- Create: `packages/extension/resources/samples/gateway.go`

- [ ] **Step 1: Create payment-service.ts**

```typescript
import { EventEmitter } from 'node:events';
import type { TransactionRepository } from './repositories/transaction-repository.js';
import type { AuthorizationGateway } from './gateways/authorization-gateway.js';
import type { FeeCalculator } from './services/fee-calculator.js';
import type { AuditLogger } from './services/audit-logger.js';

export interface PaymentRequest {
  cardNumber: string;
  expiryMonth: number;
  expiryYear: number;
  cvv: string;
  amount: number;
  currency: string;
  merchantId: string;
  reference: string;
}

export interface PaymentResult {
  transactionId: string;
  authCode: string | null;
  status: 'approved' | 'declined' | 'error';
  fee: number;
  netAmount: number;
  errorMessage?: string;
}

export class PaymentService extends EventEmitter {
  constructor(
    private readonly transactionRepo: TransactionRepository,
    private readonly authGateway: AuthorizationGateway,
    private readonly feeCalculator: FeeCalculator,
    private readonly auditLogger: AuditLogger,
  ) {
    super();
  }

  async processPayment(request: PaymentRequest): Promise<PaymentResult> {
    const transactionId = this.generateTransactionId();
    await this.auditLogger.log('payment.attempt', {
      transactionId,
      merchantId: request.merchantId,
    });

    const validation = this.validateRequest(request);
    if (!validation.valid) {
      return this.buildErrorResult(transactionId, validation.reason!);
    }

    const fee = this.feeCalculator.calculate(request.amount, request.currency);
    const netAmount = request.amount - fee;

    let authResult: { approved: boolean; authCode?: string; reason?: string };
    try {
      authResult = await this.authGateway.authorize({
        cardNumber: request.cardNumber,
        amount: request.amount,
        currency: request.currency,
        merchantId: request.merchantId,
      });
    } catch (err) {
      await this.auditLogger.log('payment.gateway_error', { transactionId, error: String(err) });
      return this.buildErrorResult(transactionId, 'Gateway unavailable');
    }

    const result: PaymentResult = authResult.approved
      ? { transactionId, authCode: authResult.authCode!, status: 'approved', fee, netAmount }
      : {
          transactionId,
          authCode: null,
          status: 'declined',
          fee: 0,
          netAmount: 0,
          errorMessage: authResult.reason,
        };

    await this.transactionRepo.save({
      id: transactionId,
      ...request,
      ...result,
      timestamp: new Date(),
    });
    await this.auditLogger.log(`payment.${result.status}`, { transactionId });
    this.emit('payment:processed', result);
    return result;
  }

  async refund(transactionId: string, amount: number): Promise<PaymentResult> {
    const original = await this.transactionRepo.findById(transactionId);
    if (!original) return this.buildErrorResult(transactionId, 'Original transaction not found');
    if (amount > original.amount)
      return this.buildErrorResult(transactionId, 'Refund amount exceeds original');

    const refundId = this.generateTransactionId();
    const refundResult = await this.authGateway.refund({
      originalTransactionId: transactionId,
      amount,
    });

    await this.transactionRepo.save({
      id: refundId,
      originalId: transactionId,
      amount,
      status: refundResult.approved ? 'approved' : 'declined',
      timestamp: new Date(),
    });

    this.emit('payment:refunded', { refundId, transactionId, amount });
    return {
      transactionId: refundId,
      authCode: refundResult.authCode ?? null,
      status: refundResult.approved ? 'approved' : 'declined',
      fee: 0,
      netAmount: amount,
    };
  }

  private validateRequest(request: PaymentRequest): { valid: boolean; reason?: string } {
    if (request.amount <= 0) return { valid: false, reason: 'Amount must be positive' };
    if (request.cardNumber.length !== 16) return { valid: false, reason: 'Invalid card number' };
    if (request.currency.length !== 3) return { valid: false, reason: 'Invalid currency code' };
    return { valid: true };
  }

  private buildErrorResult(transactionId: string, errorMessage: string): PaymentResult {
    return { transactionId, authCode: null, status: 'error', fee: 0, netAmount: 0, errorMessage };
  }

  private generateTransactionId(): string {
    return `TXN-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  }
}
```

- [ ] **Step 2: Create reconcile.py**

```python
"""reconcile.py — Daily payment reconciliation script.

Compares settlement file against bank statement, identifies
discrepancies, and produces a reconciliation report.
"""
from __future__ import annotations

import csv
import sys
from dataclasses import dataclass, field
from decimal import Decimal
from pathlib import Path


@dataclass
class SettlementRecord:
    merchant_id: str
    gross: Decimal
    fee: Decimal
    net: Decimal
    tx_count: int


@dataclass
class BankRecord:
    merchant_id: str
    credited_amount: Decimal
    value_date: str


@dataclass
class Discrepancy:
    merchant_id: str
    expected_net: Decimal
    actual_credited: Decimal
    delta: Decimal


@dataclass
class ReconciliationResult:
    matched: int = 0
    discrepancies: list[Discrepancy] = field(default_factory=list)
    missing_in_bank: list[str] = field(default_factory=list)
    missing_in_settlement: list[str] = field(default_factory=list)


def load_settlement(path: Path) -> dict[str, SettlementRecord]:
    records: dict[str, SettlementRecord] = {}
    with path.open(newline='') as f:
        for row in csv.DictReader(f):
            records[row['merchant_id']] = SettlementRecord(
                merchant_id=row['merchant_id'],
                gross=Decimal(row['gross']),
                fee=Decimal(row['fee']),
                net=Decimal(row['net']),
                tx_count=int(row['tx_count']),
            )
    return records


def load_bank_statement(path: Path) -> dict[str, BankRecord]:
    records: dict[str, BankRecord] = {}
    with path.open(newline='') as f:
        for row in csv.DictReader(f):
            records[row['merchant_id']] = BankRecord(
                merchant_id=row['merchant_id'],
                credited_amount=Decimal(row['credited_amount']),
                value_date=row['value_date'],
            )
    return records


def reconcile(
    settlement: dict[str, SettlementRecord],
    bank: dict[str, BankRecord],
    tolerance: Decimal = Decimal('0.01'),
) -> ReconciliationResult:
    result = ReconciliationResult()

    for merchant_id, settle_rec in settlement.items():
        if merchant_id not in bank:
            result.missing_in_bank.append(merchant_id)
            continue

        delta = abs(settle_rec.net - bank[merchant_id].credited_amount)
        if delta <= tolerance:
            result.matched += 1
        else:
            result.discrepancies.append(Discrepancy(
                merchant_id=merchant_id,
                expected_net=settle_rec.net,
                actual_credited=bank[merchant_id].credited_amount,
                delta=delta,
            ))

    for merchant_id in bank:
        if merchant_id not in settlement:
            result.missing_in_settlement.append(merchant_id)

    return result


def write_report(result: ReconciliationResult, out: Path) -> None:
    with out.open('w') as f:
        f.write(f'Matched:           {result.matched}\n')
        f.write(f'Discrepancies:     {len(result.discrepancies)}\n')
        f.write(f'Missing in bank:   {len(result.missing_in_bank)}\n')
        f.write(f'Missing in settle: {len(result.missing_in_settlement)}\n\n')
        if result.discrepancies:
            f.write('DISCREPANCIES:\n')
            for d in result.discrepancies:
                f.write(f'  {d.merchant_id}: expected {d.expected_net}, got {d.actual_credited}, delta {d.delta}\n')


def main(argv: list[str]) -> int:
    if len(argv) < 3:
        print(f'Usage: {argv[0]} <settlement.csv> <bank_statement.csv> [report.txt]')
        return 1

    settle_path = Path(argv[1])
    bank_path = Path(argv[2])
    report_path = Path(argv[3]) if len(argv) > 3 else Path('reconciliation_report.txt')

    settlement = load_settlement(settle_path)
    bank = load_bank_statement(bank_path)
    result = reconcile(settlement, bank)
    write_report(result, report_path)

    print(f'Reconciliation complete. Report: {report_path}')
    return 0 if not result.discrepancies else 2


if __name__ == '__main__':
    sys.exit(main(sys.argv))
```

- [ ] **Step 3: Create PaymentProcessor.java**

```java
package com.paytech.payment;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * PaymentProcessor orchestrates authorization, fee calculation,
 * and settlement for card payments.
 */
public class PaymentProcessor {

    private final AuthorizationGateway authGateway;
    private final FeePolicy feePolicy;
    private final TransactionStore transactionStore;
    private final AuditLog auditLog;

    public PaymentProcessor(
            AuthorizationGateway authGateway,
            FeePolicy feePolicy,
            TransactionStore transactionStore,
            AuditLog auditLog) {
        this.authGateway = authGateway;
        this.feePolicy = feePolicy;
        this.transactionStore = transactionStore;
        this.auditLog = auditLog;
    }

    public PaymentResult process(PaymentRequest request) {
        String transactionId = UUID.randomUUID().toString();
        auditLog.record("payment.start", transactionId, request.merchantId());

        ValidationResult validation = validate(request);
        if (!validation.isValid()) {
            return PaymentResult.declined(transactionId, validation.reason());
        }

        BigDecimal fee = feePolicy.calculateFee(request.amount(), request.currency());
        BigDecimal netAmount = request.amount().subtract(fee);

        AuthorizationResponse auth;
        try {
            auth = authGateway.authorize(
                new AuthorizationRequest(
                    request.cardNumber(), request.amount(),
                    request.currency(), request.merchantId()));
        } catch (GatewayException ex) {
            auditLog.record("payment.gateway_error", transactionId, ex.getMessage());
            return PaymentResult.error(transactionId, "Gateway unavailable");
        }

        Transaction tx = Transaction.builder()
                .id(transactionId)
                .merchantId(request.merchantId())
                .amount(request.amount())
                .fee(fee)
                .netAmount(netAmount)
                .status(auth.approved() ? Status.APPROVED : Status.DECLINED)
                .authCode(auth.authCode())
                .timestamp(Instant.now())
                .build();

        transactionStore.save(tx);
        auditLog.record("payment." + tx.status().name().toLowerCase(), transactionId, request.merchantId());

        return auth.approved()
                ? PaymentResult.approved(transactionId, auth.authCode(), fee, netAmount)
                : PaymentResult.declined(transactionId, auth.declineReason());
    }

    public RefundResult refund(String originalTransactionId, BigDecimal amount) {
        Transaction original = transactionStore.findById(originalTransactionId)
                .orElseThrow(() -> new PaymentException(
                    "Transaction not found: " + originalTransactionId));

        if (amount.compareTo(original.amount()) > 0) {
            throw new PaymentException("Refund amount exceeds original transaction amount");
        }

        AuthorizationResponse refundAuth = authGateway.refund(originalTransactionId, amount);

        Transaction refundTx = Transaction.builder()
                .id(UUID.randomUUID().toString())
                .originalId(originalTransactionId)
                .amount(amount)
                .status(refundAuth.approved() ? Status.APPROVED : Status.DECLINED)
                .timestamp(Instant.now())
                .build();

        transactionStore.save(refundTx);
        return new RefundResult(refundTx.id(), refundAuth.approved(), amount);
    }

    public List<Transaction> getDailySettlement(String merchantId, String date) {
        return transactionStore.findByMerchantAndDate(merchantId, date);
    }

    private ValidationResult validate(PaymentRequest request) {
        if (request.amount().compareTo(BigDecimal.ZERO) <= 0)
            return ValidationResult.invalid("Amount must be positive");
        if (request.cardNumber() == null || request.cardNumber().length() != 16)
            return ValidationResult.invalid("Invalid card number");
        if (request.currency() == null || request.currency().length() != 3)
            return ValidationResult.invalid("Invalid currency code");
        return ValidationResult.valid();
    }
}
```

- [ ] **Step 4: Create gateway.go**

```go
// Package gateway implements an HTTP payment gateway microservice.
// It accepts payment requests, routes to an upstream authoriser,
// and persists transaction results.
package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"
)

// PaymentRequest is the incoming JSON payload.
type PaymentRequest struct {
	CardNumber string  `json:"cardNumber"`
	ExpiryMM   int     `json:"expiryMonth"`
	ExpiryYY   int     `json:"expiryYear"`
	Amount     float64 `json:"amount"`
	Currency   string  `json:"currency"`
	MerchantID string  `json:"merchantId"`
	Reference  string  `json:"reference"`
}

// PaymentResponse is returned to callers.
type PaymentResponse struct {
	TransactionID string  `json:"transactionId"`
	Status        string  `json:"status"`
	AuthCode      string  `json:"authCode,omitempty"`
	Fee           float64 `json:"fee"`
	NetAmount     float64 `json:"netAmount"`
	ErrorMessage  string  `json:"errorMessage,omitempty"`
}

// Authoriser sends requests upstream and returns an authorisation decision.
type Authoriser interface {
	Authorize(ctx context.Context, req PaymentRequest) (authCode string, approved bool, err error)
}

// Store persists and retrieves transactions.
type Store interface {
	Save(ctx context.Context, tx Transaction) error
	FindByID(ctx context.Context, id string) (*Transaction, error)
}

// Transaction is the persisted payment record.
type Transaction struct {
	ID         string
	MerchantID string
	Amount     float64
	Currency   string
	Fee        float64
	NetAmount  float64
	Status     string
	AuthCode   string
	CreatedAt  time.Time
}

// Gateway routes payment requests through authorisation and persistence.
type Gateway struct {
	auth    Authoriser
	store   Store
	feeRate float64
	logger  *slog.Logger
}

// NewGateway constructs a Gateway with the given dependencies.
func NewGateway(auth Authoriser, store Store, feeRate float64, logger *slog.Logger) *Gateway {
	return &Gateway{auth: auth, store: store, feeRate: feeRate, logger: logger}
}

func (g *Gateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.Method == http.MethodPost && r.URL.Path == "/payments":
		g.handlePayment(w, r)
	case r.Method == http.MethodGet && len(r.URL.Path) > len("/payments/"):
		g.handleGetTransaction(w, r)
	default:
		http.NotFound(w, r)
	}
}

func (g *Gateway) handlePayment(w http.ResponseWriter, r *http.Request) {
	var req PaymentRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		g.writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if err := g.validate(req); err != nil {
		g.writeError(w, http.StatusUnprocessableEntity, err.Error())
		return
	}

	authCode, approved, err := g.auth.Authorize(r.Context(), req)
	if err != nil {
		g.logger.Error("authorisation failed", "error", err, "merchantId", req.MerchantID)
		g.writeError(w, http.StatusBadGateway, "upstream authoriser unavailable")
		return
	}

	fee := req.Amount * g.feeRate
	tx := Transaction{
		ID:         fmt.Sprintf("TXN-%d", time.Now().UnixNano()),
		MerchantID: req.MerchantID,
		Amount:     req.Amount,
		Currency:   req.Currency,
		Fee:        fee,
		NetAmount:  req.Amount - fee,
		Status:     boolStatus(approved),
		AuthCode:   authCode,
		CreatedAt:  time.Now(),
	}

	if err := g.store.Save(r.Context(), tx); err != nil {
		g.logger.Error("store.Save failed", "error", err)
	}

	g.writeJSON(w, http.StatusOK, PaymentResponse{
		TransactionID: tx.ID, Status: tx.Status, AuthCode: tx.AuthCode,
		Fee: tx.Fee, NetAmount: tx.NetAmount,
	})
}

func (g *Gateway) handleGetTransaction(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Path[len("/payments/"):]
	tx, err := g.store.FindByID(r.Context(), id)
	if errors.Is(err, ErrNotFound) {
		g.writeError(w, http.StatusNotFound, "transaction not found")
		return
	}
	if err != nil {
		g.writeError(w, http.StatusInternalServerError, "store error")
		return
	}
	g.writeJSON(w, http.StatusOK, tx)
}

func (g *Gateway) validate(req PaymentRequest) error {
	if req.Amount <= 0 {
		return errors.New("amount must be positive")
	}
	if len(req.CardNumber) != 16 {
		return errors.New("invalid card number length")
	}
	if len(req.Currency) != 3 {
		return errors.New("invalid currency code")
	}
	return nil
}

func (g *Gateway) writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v) //nolint:errcheck
}

func (g *Gateway) writeError(w http.ResponseWriter, status int, msg string) {
	g.writeJSON(w, status, map[string]string{"error": msg})
}

func boolStatus(approved bool) string {
	if approved {
		return "approved"
	}
	return "declined"
}

// ErrNotFound is returned when a transaction is not found in the store.
var ErrNotFound = errors.New("not found")
```

- [ ] **Step 5: Run tests — all 15 should now pass**

```
pnpm --filter opencob test -- tests/diagram-samples.test.ts
```

Expected: All 15 tests PASS

- [ ] **Step 6: Commit**

```bash
git add packages/extension/resources/samples/payment-service.ts \
        packages/extension/resources/samples/reconcile.py \
        packages/extension/resources/samples/PaymentProcessor.java \
        packages/extension/resources/samples/gateway.go
git commit -m "feat(extension): add modern language payment sample files (TS/Python/Java/Go)"
```

---

### Task 14: Extension wiring — command + walkthrough

**Files:**

- Modify: `packages/extension/package.json` — add `OpenCob.openSamples` command and walkthrough entry
- Modify: `packages/extension/src/extension.ts` — register the command

**Interfaces:**

- Consumes: `context.extensionUri` (available in `activate(context)`)
- Produces: `OpenCob.openSamples` command visible in the command palette and walkthrough

- [ ] **Step 1: Add command and walkthrough to package.json**

In `packages/extension/package.json`, inside `contributes.commands` array, add after the last command (after the `OpenCob.literateCoding` entry at line 156):

```json
{
  "command": "OpenCob.openSamples",
  "title": "OpenCob: Open Sample Files",
  "icon": "$(beaker)"
}
```

Then add a new top-level key `contributes.walkthroughs` (after the `keybindings` array, before `configuration`):

```json
    "walkthroughs": [
      {
        "id": "opencob.getStarted",
        "title": "Get Started with OpenCob",
        "description": "Explore AI-powered diagram generation on real legacy and modern code samples.",
        "steps": [
          {
            "id": "opencob.openSamples",
            "title": "Try Diagram Generation",
            "description": "Open the built-in sample files and generate your first diagram.\n\n[Open Sample Files](command:OpenCob.openSamples)\n\nOnce a file opens, click the **$(type-hierarchy)** icon in the editor title bar, or right-click and choose **OpenCob: Generate Diagram**.",
            "media": {
              "image": "resources/opencob-mascot.svg",
              "altText": "OpenCob mascot"
            },
            "completionEvents": [
              "onCommand:OpenCob.openSamples"
            ]
          }
        ]
      }
    ]
```

- [ ] **Step 2: Register the command in extension.ts**

In `packages/extension/src/extension.ts`, add the following block inside `activate()`, after the existing `OpenCob.togglePanel` registration (around line 1215). Follow the existing `context.subscriptions.push(vscode.commands.registerCommand(...))` pattern exactly:

```typescript
// Command: Open Sample Files — adds bundled samples folder to workspace
context.subscriptions.push(
  vscode.commands.registerCommand('OpenCob.openSamples', () => {
    const samplesPath = path.join(context.extensionUri.fsPath, 'resources', 'samples');
    const samplesUri = vscode.Uri.file(samplesPath);
    const existing = vscode.workspace.workspaceFolders ?? [];
    const alreadyAdded = existing.some((f) => f.uri.fsPath === samplesUri.fsPath);
    if (alreadyAdded) {
      vscode.window.showInformationMessage('OpenCob: Sample files are already in your workspace.');
      return;
    }
    vscode.workspace.updateWorkspaceFolders(existing.length, null, {
      uri: samplesUri,
      name: 'OpenCob Samples',
    });
    vscode.window.showInformationMessage(
      'OpenCob: Sample files added. Open any file and click $(type-hierarchy) to generate a diagram.',
    );
  }),
);
```

- [ ] **Step 3: Run the extension test suite**

```
pnpm --filter opencob test
```

Expected: All tests pass (including the 15 diagram sample tests).

- [ ] **Step 4: Build the extension to verify no TypeScript errors**

```
pnpm --filter opencob build
```

Expected: Build completes with no errors, `dist/extension.js` updated.

- [ ] **Step 5: Commit**

```bash
git add packages/extension/package.json packages/extension/src/extension.ts
git commit -m "feat(extension): add OpenCob.openSamples command and getting-started walkthrough"
```

---

### Task 15: Final verification

- [ ] **Step 1: Run full test suite**

```
pnpm test
```

Expected: All packages pass. No regressions.

- [ ] **Step 2: Run lint and typecheck**

```
pnpm lint && pnpm typecheck
```

Expected: No errors or warnings.

- [ ] **Step 3: Verify .vscodeignore does not exclude samples**

```bash
grep -i "samples" packages/extension/.vscodeignore
```

Expected: No output (samples are not excluded — they ship in the VSIX).

- [ ] **Step 4: Smoke-test the VSIX (optional — requires VS Code)**

```bash
cd packages/extension && pnpm package
```

Expected: `opencob-0.1.1.vsix` generated. Install it in VS Code (`Extensions: Install from VSIX...`). Open command palette → `OpenCob: Open Sample Files`. Verify the `OpenCob Samples` folder appears in the explorer. Open `PAYTRANS.cbl`, click the diagram icon in the editor title bar, select `call_graph`. Verify a Mermaid diagram renders in the panel.

- [ ] **Step 5: Final commit**

```bash
git add -p  # review any remaining changes
git commit -m "chore(extension): verify diagram samples ship correctly in VSIX"
```
