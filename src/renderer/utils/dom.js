/**
 * @param {ParentNode} root
 * @param {string} selector
 * @returns {HTMLElement | null}
 */
export function qs(root, selector) {
  return /** @type {HTMLElement | null} */ (root.querySelector(selector));
}

/**
 * @param {ParentNode} root
 * @param {string} selector
 * @returns {NodeListOf<HTMLElement>}
 */
export function qsa(root, selector) {
  return /** @type {NodeListOf<HTMLElement>} */ (root.querySelectorAll(selector));
}

/**
 * @param {ParentNode} root
 * @param {string} selector
 * @returns {HTMLInputElement | null}
 */
export function qsInput(root, selector) {
  return /** @type {HTMLInputElement | null} */ (root.querySelector(selector));
}

/**
 * @param {ParentNode} root
 * @param {string} selector
 * @returns {NodeListOf<HTMLInputElement>}
 */
export function qsaInputs(root, selector) {
  return /** @type {NodeListOf<HTMLInputElement>} */ (root.querySelectorAll(selector));
}

/**
 * @param {ParentNode} root
 * @param {string} selector
 * @returns {HTMLSelectElement | null}
 */
export function qsSelect(root, selector) {
  return /** @type {HTMLSelectElement | null} */ (root.querySelector(selector));
}

/**
 * @param {ParentNode} root
 * @param {string} selector
 * @returns {HTMLTextAreaElement | null}
 */
export function qsTextarea(root, selector) {
  return /** @type {HTMLTextAreaElement | null} */ (root.querySelector(selector));
}

/**
 * @param {ParentNode} root
 * @param {string} selector
 * @returns {HTMLButtonElement | null}
 */
export function qsButton(root, selector) {
  return /** @type {HTMLButtonElement | null} */ (root.querySelector(selector));
}

/**
 * @param {EventTarget | null} target
 * @param {string} selector
 * @returns {HTMLElement | null}
 */
export function closestEl(target, selector) {
  if (!(target instanceof Element)) return null;
  return /** @type {HTMLElement | null} */ (target.closest(selector));
}

/**
 * @param {EventTarget | null} target
 * @param {string} selector
 * @returns {HTMLButtonElement | null}
 */
export function closestButton(target, selector) {
  if (!(target instanceof Element)) return null;
  return /** @type {HTMLButtonElement | null} */ (target.closest(selector));
}

/**
 * @param {EventTarget | null} target
 * @param {string} selector
 * @returns {HTMLInputElement | null}
 */
export function closestInput(target, selector) {
  if (!(target instanceof Element)) return null;
  return /** @type {HTMLInputElement | null} */ (target.closest(selector));
}

/**
 * @param {EventTarget | null} target
 * @param {string} selector
 * @returns {HTMLSelectElement | null}
 */
export function closestSelect(target, selector) {
  if (!(target instanceof Element)) return null;
  return /** @type {HTMLSelectElement | null} */ (target.closest(selector));
}
