/**
 * Belt-and-braces for the global `user-select: none` (globals.css): some
 * engines — WebKit in particular — still let a selection form through edge
 * paths the CSS property doesn't cover uniformly (Select All, force-click,
 * selection drags that started elsewhere). Cancelling `selectstart` outside
 * the editable/opt-in subtrees closes those paths in every webview the app
 * ships in (WKWebView, webkit2gtk, WebView2) and in dev browsers.
 */
const SELECTABLE =
  'input, textarea, [contenteditable]:not([contenteditable="false"]), pre, code, .allow-select';

export function installNoSelectGuard(): void {
  document.addEventListener("selectstart", (e) => {
    const el = e.target instanceof Element ? e.target : null;
    if (!el?.closest(SELECTABLE)) e.preventDefault();
  });
}
