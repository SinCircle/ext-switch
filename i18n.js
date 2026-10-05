'use strict';

// Chrome resolves the browser UI language, then falls back to the English catalog.
const t = (key, substitutions) => chrome.i18n.getMessage(key, substitutions);
const UI_LANGUAGE = t('uiLanguage');
document.documentElement.lang = UI_LANGUAGE;
document.title = t('extensionName');

for (const node of document.querySelectorAll('[data-i18n]')) {
  node.textContent = t(node.dataset.i18n);
}
for (const [dataKey, attribute] of [
  ['i18nPlaceholder', 'placeholder'], ['i18nAria', 'aria-label'],
]) {
  for (const node of document.querySelectorAll(`[data-${dataKey.replace(/[A-Z]/g, c => '-' + c.toLowerCase())}]`)) {
    node.setAttribute(attribute, t(node.dataset[dataKey]));
  }
}
