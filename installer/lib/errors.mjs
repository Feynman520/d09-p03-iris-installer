// Stage failures (docs\세팅엔진-계약-v2.md "실패는 throw new StageError(...)").
//
// `code`    = the stage's error code from the contract table (E-SKELETON, ...).
// `message` = ONE Korean sentence the user will see on the screen.
// `detail`  = anything for the log (paths, child-process output, the cause).
//
// The engine wraps every other exception as E-<ID>, so a module only throws
// StageError when it can say something more useful than "알 수 없는 오류".
export class StageError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'StageError';
    this.code = code;
    this.detail = detail;
  }

  // The receipt and the progress API carry this straight to the screen, so it
  // has to survive JSON.stringify (a bare Error serialises to `{}`).
  toJSON() {
    return { name: this.name, code: this.code, message: this.message, detail: this.detail };
  }
}

export function isStageError(e) {
  return e instanceof StageError || (e && e.name === 'StageError' && typeof e.code === 'string');
}
