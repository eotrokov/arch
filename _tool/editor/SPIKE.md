# Проверка редактора на реальном GitLab

Страница проверки показывает, пускает ли ваш GitLab браузерный редактор: OAuth, чтение репозитория, создание MR.

## 1. Запрос администраторам GitLab

> Зарегистрируйте OAuth-приложение:
> - Name: arch-editor
> - Redirect URI: `<адрес Pages>/` и `http://localhost:5310/` (по одному на строку)
> - Confidential: нет
> - Scopes: api
>
> Пришлите Application ID. Secret не нужен.

Если GitLab на другом домене, чем страница, нужно также, чтобы он отвечал CORS-заголовками для адреса страницы (для `/oauth/token` и `/api/v4/*`).

## 2. config.json

Положите `config.json` в `_dist/spike/` (рядом с `index.html`):

```json
{
  "gitlabUrl": "https://gitlab.company.ru",
  "projectPath": "group/arch-model",
  "oauthClientId": "<Application ID>",
  "redirectUri": "http://localhost:5310/",
  "baseBranch": "main"
}
```

`redirectUri` должен точно совпадать с зарегистрированным. Пустой `oauthClientId` отключает вход (запасной режим).

## 3. Запуск

```sh
cd _tool
npm run spike:build
cp my-config.json _dist/spike/config.json   # ваш файл из шага 2
npm run spike:serve
```

Откройте `http://localhost:5310/` и нажмите по очереди «Войти», «Прочитать модель», «Создать тестовый MR».
Тестовый MR создаётся как Draft в ветке `arch/spike-xxxx` с файлом `_spike/<время>.txt`; после проверки его можно закрыть.

## 4. Что значат ошибки

Строка вида `✗ <шаг>: <тип> — <сообщение>`.

| Тип | Что значит |
|---|---|
| `cors-or-network` | Нет ответа: GitLab недоступен или не разрешает CORS с этого адреса. Нужна настройка CORS на стороне GitLab или другой хостинг страницы. |
| `auth` | Неверный `client_id` или `redirect_uri`, либо токен недействителен (401). |
| `forbidden` | Нет прав (403): нужна роль Developer в проекте. |
| `conflict` | Файл изменён в `main` после загрузки. |
| `other` | Прочее: смотрите сообщение GitLab (например, нет проекта или ветки). |

## 5. Результат

Результат проверки (что сработало, что нет) впишите в §11 спеки `_docs/specs/2026-11-18-arch-editor-design.md`.
