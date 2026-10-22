import { useState, type ComponentProps, type SyntheticEvent, type ReactNode } from 'react';
import { Input, type InputProps } from './ui/input.js';

export function Button({
  className = '',
  type = 'button',
  onClick,
  disabled,
  children,
}: Pick<ComponentProps<'button'>, 'className' | 'type' | 'onClick' | 'disabled' | 'children'>) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex min-h-10 items-center justify-center rounded-md bg-teal-800 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-teal-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700 disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
    >
      {children}
    </button>
  );
}
export function Field({
  label,
  name,
  type,
  className,
  value,
  defaultValue,
  readOnly,
  disabled,
  required,
  minLength,
  maxLength,
  min,
  max,
  pattern,
  inputMode,
  autoComplete,
  onChange,
  id,
}: InputProps & { label: string; name: string }) {
  return (
    <label className="grid gap-1.5 text-sm font-medium text-slate-700">
      <span>{label}</span>
      <Input
        name={name}
        type={type}
        className={className}
        value={value}
        defaultValue={defaultValue}
        readOnly={readOnly}
        disabled={disabled}
        required={required}
        minLength={minLength}
        maxLength={maxLength}
        min={min}
        max={max}
        pattern={pattern}
        inputMode={inputMode}
        autoComplete={autoComplete}
        onChange={onChange}
        id={id}
      />
    </label>
  );
}
export function ErrorNotice({ message }: { message: string | null }) {
  return message ? (
    <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900">
      {message}
    </p>
  ) : null;
}
export function AsyncForm({
  children,
  action,
  submitLabel,
}: {
  children: ReactNode;
  action: (data: FormData) => Promise<void>;
  submitLabel: string;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const submit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    setError(null);
    try {
      await action(data);
      form.reset();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Не удалось выполнить запрос');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      onSubmit={(event) => {
        void submit(event);
      }}
      className="grid gap-4"
      autoComplete="off"
    >
      <fieldset disabled={busy} className="grid gap-4">
        {children}
        <ErrorNotice message={error} />
        <Button type="submit">{busy ? 'Подождите…' : submitLabel}</Button>
      </fieldset>
    </form>
  );
}
export function text(data: FormData, key: string): string {
  const value = data.get(key);
  return typeof value === 'string' ? value : '';
}
