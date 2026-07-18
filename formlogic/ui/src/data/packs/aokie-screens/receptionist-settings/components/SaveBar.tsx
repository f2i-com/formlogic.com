/** @jsxImportSource preact */
// Sticky save bar: dirty indicator + Discard + Save + "Save & apply now"
// (the apply button pushes the composed payload; inactive records save
// without pushing - that gate lives in the store's doSaveApply).
import { dirty, discard, doSave, doSaveApply, state } from '../store';

export function SaveBar() {
  const dis = !state.mayWrite || !!state.busy.save || !!state.busy.apply;
  const dirtyNow = dirty();
  return (
    <div class="savebar">
      <div class="inner">
        {dirtyNow ? <span class="dirty">Unsaved changes</span> : <span class="clean">Saved</span>}
        <div class="right">
          {dirtyNow ? (
            <button type="button" class="btn sm" data-act="discard" onClick={discard}>Discard</button>
          ) : null}
          <button type="button" class="btn" data-act="save" disabled={dis || !dirtyNow} onClick={doSave}>
            {state.busy.save ? 'Saving...' : 'Save'}
          </button>
          {state.canSet ? (
            <button type="button" class="btn primary" data-act="save-apply" disabled={dis} onClick={doSaveApply}>
              {state.busy.apply ? 'Applying...' : 'Save & apply now'}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
