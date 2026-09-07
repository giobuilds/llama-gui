import { z } from 'zod'
import { KV_CACHE_TYPES } from './types.js'

/**
 * Anything arriving from the renderer is untrusted input to a process that
 * spawns subprocesses, so it gets validated here before the supervisor sees it.
 */
export const launchConfigSchema = z.object({
  modelPath: z.string().min(1),
  autoFit: z.boolean(),
  gpuLayers: z.number().int().min(0).max(9999),
  contextSize: z.number().int().min(0).max(1 << 22),
  flashAttn: z.boolean(),
  noWarmup: z.boolean(),
  cacheTypeK: z.enum(KV_CACHE_TYPES),
  cacheTypeV: z.enum(KV_CACHE_TYPES),
  parallel: z.number().int().min(1).max(64),
  threads: z.number().int().min(-1).max(1024),
  alias: z.string().max(200).optional(),
  extraArgs: z.string().max(4000)
})

export type LaunchConfigInput = z.infer<typeof launchConfigSchema>

/** Persisted supervisor handoff file, used to adopt or reap a server across restarts. */
export const serverHandoffSchema = z.object({
  pid: z.number().int().positive(),
  port: z.number().int().min(1).max(65535),
  startedAt: z.number(),
  config: launchConfigSchema
})

export type ServerHandoff = z.infer<typeof serverHandoffSchema>

/** A download request from the renderer. */
export const downloadRequestSchema = z.object({
  // Repo ids are "org/name"; anything else would be interpolated into a
  // filesystem path and a subprocess argument.
  repo: z
    .string()
    .min(3)
    .max(200)
    .regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/, 'expected a Hugging Face repo id like org/name'),
  file: z
    .string()
    .min(1)
    .max(300)
    .regex(/^[A-Za-z0-9._\/-]+\.gguf$/i, 'expected a .gguf file name')
    .refine((f) => !f.includes('..'), 'path traversal is not allowed'),
  expectedBytes: z.number().int().min(0)
})

/** A binary verification request from the renderer. */
export const healthCheckRequestSchema = z.object({
  modelPath: z.string().min(1),
  gpuLayers: z.number().int().min(0).max(9999)
})

/** A VRAM planning request from the renderer. */
export const planRequestSchema = z.object({
  modelPath: z.string().min(1),
  gpuLayers: z.number().int().min(0).max(9999),
  contextSize: z.number().int().min(1).max(1 << 22),
  cacheTypeK: z.enum(KV_CACHE_TYPES),
  cacheTypeV: z.enum(KV_CACHE_TYPES),
  parallel: z.number().int().min(1).max(64)
})
