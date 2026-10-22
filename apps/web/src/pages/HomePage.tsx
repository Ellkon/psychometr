/**
 * Landing page for the skeleton. Real screens (login by invitation, scales,
 * doctor registry) arrive in stages 2–5.
 */
export function HomePage() {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <h1 className="text-2xl font-semibold text-slate-900">Клинический компас</h1>
      <p className="mt-3 text-slate-700">
        Цифровой ассистент врача: шкалы PHQ-9 и GAD-7, дневник доз, правила безопасности терапии,
        маршрутизация к психиатру и алерты.
      </p>
      <p className="mt-3 text-slate-700">
        Сейчас приложение в разработке: работает каркас (этап 1 из плана). Вход по приглашению и
        шкалы появятся на этапах 2–3.
      </p>
      <div className="mt-6 flex gap-3">
        <span className="rounded-md bg-slate-100 px-3 py-1 text-sm text-slate-600">
          Для врача — скоро
        </span>
        <span className="rounded-md bg-slate-100 px-3 py-1 text-sm text-slate-600">
          Для пациента — скоро
        </span>
      </div>
    </section>
  );
}
