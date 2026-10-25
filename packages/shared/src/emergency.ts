import { z } from 'zod';

/**
 * Emergency instruction shown to the patient (FR-5.4). Bundled into the web app so it
 * works offline. A line without a confirmed source keeps `source_id: null` until the
 * clinical team names one; check-content reports every such line.
 */
export const EmergencyLineSchema = z
  .object({
    text: z.string().trim().min(1).max(300),
    source_id: z.string().min(1).nullable(),
  })
  .strict();

export const EmergencyFileSchema = z
  .object({
    id: z.literal('emergency-patient'),
    version: z.string().min(1).max(50),
    note: z.string().max(1000).optional(),
    lines: z.array(EmergencyLineSchema).min(1).max(10),
  })
  .strict();
export type EmergencyFile = z.infer<typeof EmergencyFileSchema>;
