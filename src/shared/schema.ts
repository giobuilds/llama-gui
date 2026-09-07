import { z } from 'zod'
import { KV_CACHE_TYPES } from './types.js'

/**
 * Anything arriving from the renderer is untrusted input to a process that
 * spawns subprocesses, so it gets validated here before the supervisor sees it.
 */
export const launchConfigSchema = z.object({
  modelPath: z.string().min(1),
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

/** A VRAM planning request from the renderer. */
export const planRequestSchema = z.object({
  modelPath: z.string().min(1),
  gpuLayers: z.number().int().min(0).max(9999),
  contextSize: z.number().int().min(1).max(1 << 22),
  cacheTypeK: z.enum(KV_CACHE_TYPES),
  cacheTypeV: z.enum(KV_CACHE_TYPES),
  parallel: z.number().int().min(1).max(64)
})
