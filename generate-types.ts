import * as fs from 'fs';
import * as path from 'path';

function generate(inputFile: string, outputFile: string) {
    const content = fs.readFileSync(inputFile, 'utf8');
    let tsContent = `// Generated from ${inputFile}\n\n`;

    // Match records: public record Name(type param, ...)
    const recordRegex = /public record (\w+)\((\S+)\);/g;
    let match;
    while ((match = recordRegex.exec(content)) !== null) {
        const name = match[1];
        const params = match[2].split(',').map(p => {
            const parts = p.trim().split(' ');
            const type = mapType(parts[0]);
            const field = parts[1].replace('?', '');
            return `    ${field}: ${type};`;
        });
        tsContent += `export interface ${name} {\n${params.join('\n')}\n}\n\n`;
    }

    // Match classes: public class Name { ... }
    const classRegex = /public class (\w+)\s*{([^}]+)}/g;
    while ((match = classRegex.exec(content)) !== null) {
        const name = match[1];
        const body = match[2];
        const props: string[] = [];
        const propRegex = /public (\w+[?[\]]*) (\w+) {/g;
        let pMatch;
        while ((pMatch = propRegex.exec(body)) !== null) {
            props.push(`    ${pMatch[2].charAt(0).toLowerCase() + pMatch[2].slice(1)}: ${mapType(pMatch[1])};`);
        }
        tsContent += `export interface ${name} {\n${props.join('\n')}\n}\n\n`;
    }

    fs.writeFileSync(outputFile, tsContent);
}

function mapType(csType: string): string {
    const t = csType.replace('?', '').replace('[]', '');
    const isArray = csType.includes('[]') || csType.startsWith('IEnumerable');
    
    let base = 'any';
    if (['string', 'DateTime', 'Guid'].includes(t)) base = 'string';
    else if (['int', 'long', 'float', 'double', 'decimal'].includes(t)) base = 'number';
    else if (['bool'].includes(t)) base = 'boolean';
    else if (t === 'PhotoResponse') base = 'PhotoResponse'; // Manual link for now
    else if (t.startsWith('IEnumerable<')) {
        const inner = t.match(/<(\w+)>/)?.[1] || 'any';
        return mapType(inner) + '[]';
    }

    return isArray ? `${base}[]` : base;
}

generate('Requests.cs', 'wwwsrc/Requests.generated.d.ts');
generate('Responses.cs', 'wwwsrc/Responses.generated.d.ts');
console.log('TypeScript types generated successfully.');
