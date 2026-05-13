import type { CobolProgram, CobolDataItem, CobolParagraph } from './cobol-parser.js';
import type { RpgProgram, RpgDataStructure } from './rpg-parser.js';

/** Translation suggestion for a legacy code element */
export interface TranslationSuggestion {
  sourceLanguage: 'cobol' | 'rpg';
  targetLanguage: 'java' | 'kotlin' | 'csharp';
  sourceName: string;
  sourceCode: string;
  translatedCode: string;
  comments: string[];
}

/** A generated JPA/DTO entity from legacy data definitions */
export interface GeneratedEntity {
  className: string;
  sourceLanguage: 'cobol' | 'rpg';
  sourceName: string;
  code: string;
  fields: Array<{ name: string; javaType: string; originalName: string; originalType: string }>;
}

/** A generated test stub */
export interface GeneratedTestStub {
  className: string;
  code: string;
  testMethods: string[];
}

/**
 * Modernization Assistant — generates translation scaffolding
 * from COBOL/RPG to modern languages (Java/Kotlin/C#).
 *
 * All output is shown as diffs for human review — never auto-committed.
 */
export class ModernizationAssistant {

  /** Generate a Java class from COBOL copybook data items */
  generateEntityFromCopybook(
    dataItems: CobolDataItem[],
    copybookName: string,
  ): GeneratedEntity {
    const className = this.toClassName(copybookName);
    const fields: GeneratedEntity['fields'] = [];
    const javaFields: string[] = [];
    const gettersSetters: string[] = [];

    // Process only 01-level and their children
    for (const item of dataItems) {
      if (item.level === 88 || item.level === 66) continue;
      if (item.name === 'FILLER') continue;

      const javaType = this.cobolTypeToJava(item);
      const fieldName = this.toCamelCase(item.name);

      fields.push({
        name: fieldName,
        javaType,
        originalName: item.name,
        originalType: item.picture ?? item.usage ?? 'GROUP',
      });

      javaFields.push(`    /** COBOL: ${item.level} ${item.name} ${item.picture ?? ''} */`);
      javaFields.push(`    private ${javaType} ${fieldName};`);

      // Getter
      gettersSetters.push(`    public ${javaType} get${this.capitalize(fieldName)}() {`);
      gettersSetters.push(`        return this.${fieldName};`);
      gettersSetters.push('    }');
      gettersSetters.push('');

      // Setter
      gettersSetters.push(`    public void set${this.capitalize(fieldName)}(${javaType} ${fieldName}) {`);
      gettersSetters.push(`        this.${fieldName} = ${fieldName};`);
      gettersSetters.push('    }');
      gettersSetters.push('');
    }

    const code = [
      `// Auto-generated from COBOL copybook: ${copybookName}`,
      '// Review carefully before committing — business logic may require adjustment.',
      '',
      'import javax.persistence.Entity;',
      'import javax.persistence.Id;',
      'import javax.persistence.Column;',
      'import java.math.BigDecimal;',
      '',
      '@Entity',
      `public class ${className} {`,
      '',
      ...javaFields,
      '',
      ...gettersSetters,
      '}',
    ].join('\n');

    return { className, sourceLanguage: 'cobol', sourceName: copybookName, code, fields };
  }

  /** Generate a Java class from RPG data structure */
  generateEntityFromRpgDs(ds: RpgDataStructure): GeneratedEntity {
    const className = this.toClassName(ds.name);
    const fields: GeneratedEntity['fields'] = [];
    const javaFields: string[] = [];

    for (const field of ds.fields) {
      const javaType = this.rpgTypeToJava(field.type);
      const fieldName = this.toCamelCase(field.name);

      fields.push({
        name: fieldName,
        javaType,
        originalName: field.name,
        originalType: field.type,
      });

      javaFields.push(`    /** RPG: ${field.name} ${field.type} */`);
      javaFields.push(`    private ${javaType} ${fieldName};`);
    }

    const code = [
      `// Auto-generated from RPG data structure: ${ds.name}`,
      '// Review carefully before committing.',
      '',
      'import java.math.BigDecimal;',
      '',
      `public class ${className} {`,
      '',
      ...javaFields,
      '}',
    ].join('\n');

    return { className, sourceLanguage: 'rpg', sourceName: ds.name, code, fields };
  }

  /** Generate test stubs for a COBOL program's paragraphs */
  generateCobolTestStubs(program: CobolProgram): GeneratedTestStub {
    const className = this.toClassName(program.programId) + 'Test';
    const testMethods: string[] = [];

    for (const para of program.paragraphs) {
      const methodName = `test${this.toClassName(para.name)}`;
      testMethods.push(methodName);
    }

    const methodCode = testMethods.map((name) => [
      `    @Test`,
      `    void ${name}() {`,
      `        // TODO: Implement test logic`,
      `        // Verify business rules for this paragraph`,
      `    }`,
    ].join('\n')).join('\n\n');

    const code = [
      `// Test stubs for COBOL program: ${program.programId}`,
      '// Each test maps to a COBOL paragraph.',
      '',
      'import org.junit.jupiter.api.Test;',
      'import static org.junit.jupiter.api.Assertions.*;',
      '',
      `class ${className} {`,
      '',
      methodCode,
      '}',
    ].join('\n');

    return { className, code, testMethods };
  }

  /** Generate test stubs for RPG procedures */
  generateRpgTestStubs(program: RpgProgram): GeneratedTestStub {
    const baseName = program.filePath.split('/').pop()?.replace(/\.\w+$/, '') ?? 'RpgProgram';
    const className = this.toClassName(baseName) + 'Test';
    const testMethods: string[] = [];

    for (const proc of program.procedures) {
      testMethods.push(`test${this.toClassName(proc.name)}`);
    }
    for (const sub of program.subroutines) {
      testMethods.push(`test${this.toClassName(sub.name)}`);
    }

    const methodCode = testMethods.map((name) => [
      `    @Test`,
      `    void ${name}() {`,
      `        // TODO: Implement test`,
      `    }`,
    ].join('\n')).join('\n\n');

    const code = [
      `// Test stubs for RPG program: ${baseName}`,
      '',
      'import org.junit.jupiter.api.Test;',
      'import static org.junit.jupiter.api.Assertions.*;',
      '',
      `class ${className} {`,
      '',
      methodCode,
      '}',
    ].join('\n');

    return { className, code, testMethods };
  }

  /** Translate a COBOL paragraph to Java method scaffolding */
  translateParagraphToJava(
    para: CobolParagraph,
    sourceLines: string[],
  ): TranslationSuggestion {
    const paraLines = sourceLines.slice(para.line - 1, para.endLine);
    const sourceCode = paraLines.join('\n');
    const methodName = this.toCamelCase(para.name);
    const comments: string[] = [
      `Translated from COBOL paragraph: ${para.name}`,
      `Original lines: ${para.line}–${para.endLine}`,
    ];

    if (para.performedBy.length > 0) {
      comments.push(`Called by: ${para.performedBy.join(', ')}`);
    }

    const translatedCode = [
      `/**`,
      ...comments.map((c) => ` * ${c}`),
      ` */`,
      `public void ${methodName}() {`,
      `    // TODO: Translate COBOL logic`,
      ...paraLines
        .filter((l) => l.trim().length > 0)
        .map((l) => `    // ${l.trim()}`),
      `}`,
    ].join('\n');

    return {
      sourceLanguage: 'cobol',
      targetLanguage: 'java',
      sourceName: para.name,
      sourceCode,
      translatedCode,
      comments,
    };
  }

  // ── Private helpers ──────────────────────────────────────────

  private cobolTypeToJava(item: CobolDataItem): string {
    if (!item.picture) return 'Object';

    const pic = item.picture.toUpperCase();

    // COMP-3 / packed decimal → BigDecimal
    if (item.usage === 'COMP-3' || item.usage === 'PACKED-DECIMAL') {
      return 'BigDecimal';
    }

    // Numeric with decimals → BigDecimal
    if (pic.includes('V') || pic.includes('.')) {
      return 'BigDecimal';
    }

    // Numeric without decimals
    if (/^S?9[\d()]*$/.test(pic)) {
      const digits = (pic.match(/9/g) ?? []).length;
      if (digits <= 9) return 'int';
      if (digits <= 18) return 'long';
      return 'BigDecimal';
    }

    // Alphanumeric
    if (pic.startsWith('X') || pic.startsWith('A')) {
      return 'String';
    }

    return 'String';
  }

  private rpgTypeToJava(rpgType: string): string {
    const upper = rpgType.toUpperCase();
    if (upper.includes('CHAR') || upper.includes('VARCHAR')) return 'String';
    if (upper.includes('PACKED') || upper.includes('ZONED')) return 'BigDecimal';
    if (upper.includes('INT')) return 'int';
    if (upper.includes('FLOAT')) return 'double';
    if (upper.includes('DATE')) return 'LocalDate';
    if (upper.includes('TIME')) return 'LocalTime';
    if (upper.includes('TIMESTAMP')) return 'LocalDateTime';
    if (upper.includes('IND')) return 'boolean';
    return 'String';
  }

  private toClassName(name: string): string {
    return name
      .split(/[-_]/)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
      .join('');
  }

  private toCamelCase(name: string): string {
    const className = this.toClassName(name);
    return className.charAt(0).toLowerCase() + className.slice(1);
  }

  private capitalize(str: string): string {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }
}
