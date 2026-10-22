import { Link, useNavigate } from '@tanstack/react-router';
import { PatientLoginSchema, StaffLoginSchema } from '@psychometr/shared';
import { clearPrivateState, sessionClient, useSession } from '../lib/session.js';
import { AsyncForm, Field, text } from '../components/forms.js';
import { Card, CardContent, CardHeader } from '../components/ui/card.js';

export function LoginPage({ patient = false }: { patient?: boolean }) {
  const session = useSession(),
    navigate = useNavigate();
  if (!session.ready) return <p role="status">Проверяем сессию…</p>;
  if (session.user)
    return (
      <p>
        Вы уже вошли.{' '}
        <Link to="/" className="text-teal-800 underline">
          Открыть рабочий экран
        </Link>
      </p>
    );
  return (
    <div className="mx-auto max-w-md">
      <Card>
        <CardHeader>
          <p className="text-xs font-semibold uppercase tracking-wider text-teal-700">
            Защищённый вход
          </p>
          <h1 className="text-2xl font-semibold">
            {patient ? 'Вход пациента' : 'Вход специалиста'}
          </h1>
          <p className="text-sm text-slate-600">
            {patient
              ? 'На этом устройстве сначала нужно один раз войти по приглашению врача.'
              : 'Для врача и администратора. Регистрация доступна только через администратора.'}
          </p>
        </CardHeader>
        <CardContent>
          <AsyncForm
            submitLabel="Войти"
            action={async (data) => {
              const input = patient
                ? PatientLoginSchema.safeParse({ personalCode: text(data, 'personalCode') })
                : StaffLoginSchema.safeParse({
                    email: text(data, 'email'),
                    password: text(data, 'password'),
                  });
              if (!input.success) throw new Error('Проверьте поля формы');
              await clearPrivateState();
              await sessionClient.signIn(
                patient ? '/api/auth/patient/login' : '/api/auth/login',
                input.data,
              );
              await navigate({ to: '/' });
            }}
          >
            {patient ? (
              <Field
                label="Личный шестизначный код"
                name="personalCode"
                type="password"
                inputMode="numeric"
                pattern="[0-9]{6}"
                minLength={6}
                maxLength={6}
                autoComplete="current-password"
                required
              />
            ) : (
              <>
                <Field
                  label="Электронная почта"
                  name="email"
                  type="email"
                  autoComplete="username"
                  maxLength={254}
                  required
                />
                <Field
                  label="Пароль"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  maxLength={128}
                  required
                />
              </>
            )}
          </AsyncForm>
          <p className="mt-4 text-sm text-slate-600">
            После пяти неверных попыток вход временно блокируется.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
