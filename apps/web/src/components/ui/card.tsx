// Adapted from shadcn/ui Card (MIT), with an explicit, restricted prop surface.
import type { ReactNode } from 'react';
interface CardProps {
  children: ReactNode;
  className?: string;
}
export function Card({ className = '', children }: CardProps) {
  return (
    <section
      data-slot="card"
      className={`flex flex-col gap-5 rounded-xl border border-slate-200 bg-white py-6 text-slate-900 shadow-sm ${className}`}
    >
      {children}
    </section>
  );
}
export function CardHeader({ className = '', children }: CardProps) {
  return (
    <div data-slot="card-header" className={`grid gap-2 px-6 ${className}`}>
      {children}
    </div>
  );
}
export function CardContent({ className = '', children }: CardProps) {
  return (
    <div data-slot="card-content" className={`px-6 ${className}`}>
      {children}
    </div>
  );
}
