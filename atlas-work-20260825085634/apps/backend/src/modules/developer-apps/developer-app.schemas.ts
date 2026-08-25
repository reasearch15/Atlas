import { z } from "zod";
import { createDeveloperAppSchema, updateDeveloperAppSchema, uuidSchema } from "@atlas/shared";

export const developerAppParamsSchema = z.object({
  id: uuidSchema
});

export const createDeveloperAppBodySchema = createDeveloperAppSchema;
export const updateDeveloperAppBodySchema = updateDeveloperAppSchema;
