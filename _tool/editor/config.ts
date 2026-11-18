// Настройки редактора: config.json лежит рядом со страницей.
export interface EditorConfig {
  gitlabUrl: string;
  projectPath: string;
  oauthClientId: string;
  redirectUri: string;
  baseBranch: string;
}

/** null — файла нет, он не разбирается или `oauthClientId` пуст (запасной режим). */
export async function loadConfig(fetchFn: typeof fetch, url = 'config.json'): Promise<EditorConfig | null> {
  try {
    const res = await fetchFn(url);
    if (!res.ok) return null;
    const raw = (await res.json()) as Partial<EditorConfig> | null;
    if (!raw || typeof raw.oauthClientId !== 'string' || raw.oauthClientId.trim() === '') return null;
    return {
      gitlabUrl: String(raw.gitlabUrl ?? '').replace(/\/+$/, ''),
      projectPath: String(raw.projectPath ?? ''),
      oauthClientId: raw.oauthClientId,
      redirectUri: String(raw.redirectUri ?? ''),
      baseBranch: String(raw.baseBranch ?? 'main'),
    };
  } catch {
    return null;
  }
}
