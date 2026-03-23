import type { Env } from '../types.js';

/**
 * /auth/login - loads Clerk JS, redirects to hosted sign-in.
 *
 * Flow:
 * 1. CLI opens browser → /auth/login?callback=...&state=...
 * 2. Clerk.load() → if already signed in → grab token+email → redirect to CLI
 * 3. If not signed in → redirectToSignIn() → Clerk hosted UI
 * 4. After sign-in → Clerk redirects to /auth/callback
 */
export function handleAuthLoginPage(request: Request, env: Env): Response {
  const url = new URL(request.url);
  const callback = url.searchParams.get('callback') ?? '';
  const state = url.searchParams.get('state') ?? '';
  const pk = env.CLERK_PUBLISHABLE_KEY;

  const afterSignInUrl = `https://api.workslocal.dev/auth/callback?callback=${encodeURIComponent(callback)}&state=${state}`;

  const html = `<!DOCTYPE html>
<html><head>
  <meta charset="utf-8">
  <title>WorksLocal - Sign In</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: system-ui; background: #0a0a0a; color: #fff; display: flex;
           justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
    #app { width: 400px; text-align: center; }
    h1 { font-size: 1.5rem; margin-bottom: 2rem; }
    .loading { color: #888; }
    .error { color: #ef4444; margin-top: 1rem; display: none; }
  </style>
</head><body>
  <div id="app">
    <h1>WorksLocal</h1>
    <p class="loading" id="loading">Redirecting to sign-in...</p>
    <p class="error" id="error"></p>
  </div>
  <script
    async
    crossorigin="anonymous"
    data-clerk-publishable-key="${pk}"
    src="https://cdn.jsdelivr.net/npm/@clerk/clerk-js@latest/dist/clerk.browser.js"
    type="text/javascript"
  ></script>
  <script>
    var CALLBACK = decodeURIComponent('${encodeURIComponent(callback)}');
    var STATE = '${state}';
    var AFTER_SIGN_IN = '${afterSignInUrl}';

    window.addEventListener('load', async function() {
      try {
        await window.Clerk.load();

        if (window.Clerk.user) {
          var token = await window.Clerk.session.getToken();
          var email = window.Clerk.user.primaryEmailAddress
            ? window.Clerk.user.primaryEmailAddress.emailAddress
            : '';
          window.location.href = CALLBACK
            + '?token=' + encodeURIComponent(token)
            + '&state=' + STATE
            + '&email=' + encodeURIComponent(email);
          return;
        }

        window.Clerk.redirectToSignIn({
          afterSignInUrl: AFTER_SIGN_IN,
        });
      } catch (err) {
        document.getElementById('loading').style.display = 'none';
        var errorEl = document.getElementById('error');
        errorEl.style.display = 'block';
        errorEl.textContent = 'Error: ' + err.message;
      }
    });
  </script>
</body></html>`;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html' },
  });
}

/**
 * /auth/callback - receives redirect from Clerk after sign-in.
 * Grabs session token + email → redirects to CLI's local callback.
 */
export function handleAuthCallback(request: Request, env: Env): Response {
  const url = new URL(request.url);
  const callback = url.searchParams.get('callback') ?? '';
  const state = url.searchParams.get('state') ?? '';
  const pk = env.CLERK_PUBLISHABLE_KEY;

  const html = `<!DOCTYPE html>
<html><head>
  <meta charset="utf-8">
  <title>WorksLocal - Completing sign-in...</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: system-ui; background: #0a0a0a; color: #fff; display: flex;
           justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
    #app { text-align: center; }
    .loading { color: #888; }
    .error { color: #ef4444; margin-top: 1rem; display: none; }
  </style>
</head><body>
  <div id="app">
    <p class="loading" id="loading">Completing sign-in...</p>
    <p class="error" id="error"></p>
  </div>
  <script
    async
    crossorigin="anonymous"
    data-clerk-publishable-key="${pk}"
    src="https://cdn.jsdelivr.net/npm/@clerk/clerk-js@latest/dist/clerk.browser.js"
    type="text/javascript"
  ></script>
  <script>
    var CALLBACK = decodeURIComponent('${encodeURIComponent(callback)}');
    var STATE = '${state}';

    window.addEventListener('load', async function() {
      try {
        await window.Clerk.load();

        if (window.Clerk.user) {
          var token = await window.Clerk.session.getToken();
          var email = window.Clerk.user.primaryEmailAddress
            ? window.Clerk.user.primaryEmailAddress.emailAddress
            : '';
          window.location.href = CALLBACK
            + '?token=' + encodeURIComponent(token)
            + '&state=' + STATE
            + '&email=' + encodeURIComponent(email);
          return;
        }

        document.getElementById('loading').style.display = 'none';
        var errorEl = document.getElementById('error');
        errorEl.style.display = 'block';
        errorEl.textContent = 'Sign-in was not completed. Please close this tab and try "workslocal login" again.';
      } catch (err) {
        document.getElementById('loading').style.display = 'none';
        var errorEl = document.getElementById('error');
        errorEl.style.display = 'block';
        errorEl.textContent = 'Error: ' + err.message;
      }
    });
  </script>
</body></html>`;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html' },
  });
}
