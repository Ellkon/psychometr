/**
 * Emergency instruction for the patient (FR-5.4). The text lives in content/ and is
 * bundled with the app, so it stays available offline and never waits for a doctor.
 */
import { EmergencyFileSchema } from '@psychometr/shared';
import emergencyContent from '../../../../content/emergency/patient.ru.json';

export const EMERGENCY_LINES: readonly string[] = EmergencyFileSchema.parse(
  emergencyContent,
).lines.map((line) => line.text);

export function EmergencyInstruction({ emphasis = false }: { emphasis?: boolean }) {
  return (
    <section
      aria-label="Экстренная помощь"
      className={`grid gap-2 rounded-md border p-4 text-sm leading-relaxed ${
        emphasis
          ? 'border-red-300 bg-red-50 text-red-950'
          : 'border-slate-200 bg-slate-50 text-slate-800'
      }`}
    >
      {EMERGENCY_LINES.map((line) => (
        <p key={line}>{line}</p>
      ))}
    </section>
  );
}
