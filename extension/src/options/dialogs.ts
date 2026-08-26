/**
 * In-page modal prompts via <dialog> — replaces window.prompt, which is
 * unreliable from extension pages in Safari (and clunky everywhere). One
 * dialog element, created lazily, reused for every prompt; resolves to the
 * entered string, or null on cancel/escape — the window.prompt contract.
 */

let dialog: HTMLDialogElement | undefined;
let messageEl: HTMLParagraphElement;
let inputEl: HTMLInputElement;
let okButton: HTMLButtonElement;

function ensureDialog(): HTMLDialogElement {
  if (dialog !== undefined) return dialog;
  dialog = document.createElement("dialog");
  dialog.style.cssText =
    "max-width: 380px; border: 1px solid #bbb; border-radius: 6px; padding: 16px;";
  const form = document.createElement("form");
  form.method = "dialog";
  messageEl = document.createElement("p");
  messageEl.style.cssText = "margin: 0 0 10px; font-size: 14px;";
  inputEl = document.createElement("input");
  inputEl.style.cssText = "width: 100%; box-sizing: border-box; padding: 6px 8px;";
  const row = document.createElement("div");
  row.style.cssText = "display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px;";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => dialog?.close("cancel"));
  okButton = document.createElement("button");
  okButton.type = "submit";
  okButton.value = "ok";
  okButton.textContent = "OK";
  row.append(cancel, okButton);
  form.append(messageEl, inputEl, row);
  dialog.append(form);
  document.body.append(dialog);
  return dialog;
}

export interface PromptOptions {
  /** Render the input as a password field (PIN entry). */
  password?: boolean;
  /** OK button label; default "OK". */
  confirmLabel?: string;
}

/**
 * Show a modal prompt. Resolves with the trimmed-as-entered value on OK,
 * null on cancel — exactly the window.prompt contract the callers expect.
 */
export function promptDialog(
  message: string,
  options: PromptOptions = {},
): Promise<string | null> {
  const d = ensureDialog();
  messageEl.textContent = message;
  inputEl.type = options.password === true ? "password" : "text";
  inputEl.value = "";
  okButton.textContent = options.confirmLabel ?? "OK";
  return new Promise((resolve) => {
    d.addEventListener(
      "close",
      () => {
        resolve(d.returnValue === "ok" ? inputEl.value : null);
      },
      { once: true },
    );
    d.showModal();
    inputEl.focus();
  });
}
