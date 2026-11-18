import { describe, it, expect } from 'vitest';
import { authorizeUrl, challengeFor, createPkce } from '../editor/gitlab/oauth.js';
import type { EditorConfig } from '../editor/config.js';

const cfg: EditorConfig = {
  gitlabUrl: 'https://gitlab.example.com',
  projectPath: 'grp/arch',
  oauthClientId: 'cid',
  redirectUri: 'http://localhost:5310/',
  baseBranch: 'main',
};

describe('oauth PKCE', () => {
  it('challengeFor совпадает с вектором RFC 7636', async () => {
    expect(await challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('createPkce: verifier 64 символа base64url, challenge соответствует', async () => {
    const a = await createPkce();
    const b = await createPkce();
    expect(a.verifier).toMatch(/^[A-Za-z0-9_-]{64}$/);
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.challenge).toBe(await challengeFor(a.verifier));
  });

  it('authorizeUrl содержит все параметры', () => {
    const u = new URL(authorizeUrl(cfg, 'CH', 'ST'));
    expect(u.origin + u.pathname).toBe('https://gitlab.example.com/oauth/authorize');
    expect(Object.fromEntries(u.searchParams)).toEqual({
      client_id: 'cid',
      redirect_uri: 'http://localhost:5310/',
      response_type: 'code',
      state: 'ST',
      code_challenge: 'CH',
      code_challenge_method: 'S256',
      scope: 'api',
    });
  });
});
