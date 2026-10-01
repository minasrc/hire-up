export class ParserError extends Error {
    constructor(code) { super(code); this.name = 'ParserError'; this.code = code; }
}
export const fail = code => { throw new ParserError(code); };
