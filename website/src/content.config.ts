import { defineCollection } from "astro:content";
import { docsLoader } from "@astrojs/starlight/loaders";
import { docsSchema } from "@astrojs/starlight/schema";
import { z } from "astro/zod";

const provenanceSchema = z
  .object({
    generatedFrom: z.string(),
    chips: z
      .array(z.object({ label: z.string(), value: z.string() }).strict())
      .optional(),
  })
  .strict();

export const collections = {
  docs: defineCollection({
    loader: docsLoader(),
    schema: docsSchema({
      extend: z.object({ provenance: provenanceSchema.optional() }),
    }),
  }),
};
