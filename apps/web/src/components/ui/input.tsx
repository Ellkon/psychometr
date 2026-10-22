// Adapted from shadcn/ui Input (MIT). Only explicitly allowed DOM attributes are forwarded.
import type { ComponentProps } from 'react';
export type InputProps = Pick<
  ComponentProps<'input'>,
  | 'className'
  | 'type'
  | 'name'
  | 'value'
  | 'defaultValue'
  | 'readOnly'
  | 'disabled'
  | 'required'
  | 'minLength'
  | 'maxLength'
  | 'min'
  | 'max'
  | 'pattern'
  | 'inputMode'
  | 'autoComplete'
  | 'onChange'
  | 'id'
>;
export function Input({
  className = '',
  type,
  name,
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
}: InputProps) {
  return (
    <input
      type={type}
      name={name}
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
      data-slot="input"
      className={`flex h-10 w-full min-w-0 rounded-md border border-slate-300 bg-white px-3 py-2 text-base shadow-xs outline-none transition-colors placeholder:text-slate-400 focus-visible:border-teal-600 focus-visible:ring-2 focus-visible:ring-teal-200 disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
    />
  );
}
