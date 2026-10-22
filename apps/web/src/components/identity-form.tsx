import { PatientIdentitySchema, type PatientIdentity } from '@psychometr/shared';
import { AsyncForm, Field, text } from './forms.js';

export function IdentityForm({
  initial,
  submit,
  label,
}: {
  initial?: PatientIdentity;
  submit: (identity: PatientIdentity) => Promise<void>;
  label: string;
}) {
  return (
    <AsyncForm
      submitLabel={label}
      action={async (data) => {
        const parsed = PatientIdentitySchema.safeParse({
          firstName: text(data, 'firstName'),
          lastName: text(data, 'lastName'),
          middleName: text(data, 'middleName') || null,
          birthDate: text(data, 'birthDate') || null,
          phone: text(data, 'phone') || null,
          snils: text(data, 'snils') || null,
        });
        if (!parsed.success) throw new Error('Проверьте имя, фамилию и формат заполненных полей');
        await submit(parsed.data);
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Фамилия"
          name="lastName"
          maxLength={100}
          required
          defaultValue={initial?.lastName}
        />
        <Field
          label="Имя"
          name="firstName"
          maxLength={100}
          required
          defaultValue={initial?.firstName}
        />
        <Field
          label="Отчество, если есть"
          name="middleName"
          maxLength={100}
          defaultValue={initial?.middleName ?? ''}
        />
        <Field
          label="Дата рождения"
          name="birthDate"
          type="date"
          max={new Date().toISOString().slice(0, 10)}
          defaultValue={initial?.birthDate ?? ''}
        />
        <Field
          label="Телефон"
          name="phone"
          type="tel"
          maxLength={30}
          defaultValue={initial?.phone ?? ''}
        />
        <Field
          label="СНИЛС, 11 цифр"
          name="snils"
          inputMode="numeric"
          pattern="[0-9]{11}"
          maxLength={11}
          defaultValue={initial?.snils ?? ''}
        />
      </div>
      <p className="text-xs text-slate-500">
        Пока система проходит проверку, используйте только вымышленные данные. ФИО и контакты
        хранятся зашифрованными.
      </p>
    </AsyncForm>
  );
}
