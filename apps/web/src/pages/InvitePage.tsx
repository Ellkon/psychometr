import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { AcceptInviteSchema, ConsentDocumentSchema } from '@psychometr/shared';
import { clearPrivateState, sessionClient } from '../lib/session.js';
import { clearInviteToken, getInviteToken } from '../lib/invite-token.js';
import { AsyncForm, ErrorNotice, Field, text } from '../components/forms.js';
import { Card, CardContent, CardHeader } from '../components/ui/card.js';

export function InvitePage() {
  const token = getInviteToken(),
    navigate = useNavigate();
  const consent = useQuery({
    queryKey: ['consent'],
    queryFn: ({ signal }) =>
      sessionClient.publicRequest('/api/auth/consent', ConsentDocumentSchema, { signal }),
    enabled: Boolean(token),
  });
  const document = consent.data;
  return (
    <div className="mx-auto max-w-xl">
      <Card>
        <CardHeader>
          <h1 className="text-2xl font-semibold">Приглашение пациента</h1>
          <p className="text-sm text-slate-600">
            Секретная часть ссылки уже удалена из адресной строки. Не обновляйте страницу до
            завершения входа.
          </p>
        </CardHeader>
        <CardContent>
          {!token ? (
            <ErrorNotice message="Откройте полную ссылку из приглашения врача. После обновления этой страницы секрет нужно получить из ссылки заново." />
          ) : consent.isPending ? (
            <p>Загрузка согласия…</p>
          ) : consent.error ? (
            <ErrorNotice message={consent.error.message} />
          ) : document ? (
            <AsyncForm
              submitLabel="Принять приглашение"
              action={async (data) => {
                const input = AcceptInviteSchema.safeParse({
                  token,
                  code: text(data, 'code'),
                  personalCode: text(data, 'personalCode'),
                  consentVersion: document.version,
                  consentAccepted: data.get('consentAccepted') === 'on',
                });
                if (!input.success || text(data, 'personalCode') !== text(data, 'repeatCode'))
                  throw new Error('Проверьте оба кода, их совпадение и отметку согласия');
                await clearPrivateState();
                await sessionClient.signIn('/api/auth/invites/accept', input.data);
                clearInviteToken();
                await navigate({ to: '/' });
              }}
            >
              <Field
                label="Код из приглашения врача"
                name="code"
                type="password"
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                autoComplete="one-time-code"
                required
              />
              <Field
                label="Личный код пациента"
                name="personalCode"
                type="password"
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                autoComplete="new-password"
                required
              />
              <Field
                label="Повторите личный код"
                name="repeatCode"
                type="password"
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                autoComplete="new-password"
                required
              />
              <p className="text-sm text-slate-600">
                При первом входе придумайте личный код. Если подключаете ещё одно устройство,
                введите уже установленный код.
              </p>
              <div
                className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-md border border-slate-200 p-4 text-sm"
                aria-label="Текст согласия"
              >
                {document.text}
              </div>
              <p className="text-xs text-slate-500">Версия согласия: {document.version}</p>
              <label className="flex items-start gap-3 text-sm">
                <input
                  type="checkbox"
                  name="consentAccepted"
                  required
                  className="mt-1 h-4 w-4 accent-teal-800"
                />
                <span>Я прочитал(а) текст и даю согласие на указанных в нём условиях.</span>
              </label>
            </AsyncForm>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
