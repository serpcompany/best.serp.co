import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ScheduledJobFailure } from '../telemetry/worker-errors'
import { LOAD_SCHEDULED_JOBS, runScheduled, type ScheduledJobsModule } from './run-scheduled'
import { handleScheduled, type ScheduledJob, type ScheduledJobInput } from './scheduled'

const HOURLY = '0 * * * *'
const DAILY = '45 3 * * *'
const event = { cron: HOURLY, scheduledTime: Date.parse('2026-10-13T10:00:00.000Z') }
const context = { waitUntil: vi.fn() }

function job(name: string, run: ScheduledJob['run'] = async () => ({})): ScheduledJob {
  return { name, run: vi.fn(run) }
}

function reporter() {
  const reported: ScheduledJobFailure[][] = []
  return {
    reported,
    reportFailures: vi.fn(async (failures: readonly ScheduledJobFailure[]) => {
      reported.push([...failures])
    })
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('runScheduled', () => {
  it('loads the jobs when a trigger fires and runs only that trigger’s jobs', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const hourly = job('hourly')
    const daily = job('daily')
    const load = vi.fn(
      async (): Promise<ScheduledJobsModule> => ({
        handleScheduled,
        scheduledJobs: { [DAILY]: [daily], [HOURLY]: [hourly] }
      })
    )
    const { reportFailures } = reporter()

    await runScheduled(event, {}, context, { load, reportFailures })

    expect(load).toHaveBeenCalledOnce()
    expect(hourly.run).toHaveBeenCalledOnce()
    const [input] = vi.mocked(hourly.run).mock.calls[0] as [ScheduledJobInput]
    expect(input.now.getTime()).toBe(event.scheduledTime)
    expect(daily.run).not.toHaveBeenCalled()
    expect(reportFailures).not.toHaveBeenCalled()
  })

  it('passes the reporter on, so a failed job still reaches it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const error = new Error('job failed')
    const { reportFailures, reported } = reporter()

    await expect(
      runScheduled(event, {}, context, {
        load: async () => ({
          handleScheduled,
          scheduledJobs: {
            [HOURLY]: [
              job('broken', async () => {
                throw error
              })
            ]
          }
        }),
        reportFailures
      })
    ).rejects.toThrow(AggregateError)
    expect(reported).toEqual([[{ error, job: 'broken' }]])
  })

  it('reports a failed load as a failed job, logs it, and rethrows the same error', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const error = new TypeError('module graph threw')
    const { reportFailures, reported } = reporter()

    await expect(
      runScheduled(event, {}, context, { load: () => Promise.reject(error), reportFailures })
    ).rejects.toBe(error)

    expect(reported).toEqual([[{ error, job: LOAD_SCHEDULED_JOBS }]])
    expect(logged).toHaveBeenCalledOnce()
    expect(JSON.parse(String(logged.mock.calls[0]?.[0]))).toMatchObject({
      cron: HOURLY,
      event: 'scheduled_job_failed',
      job: LOAD_SCHEDULED_JOBS
    })
  })

  it('keeps the jobs off the start-up path: the Worker entry and this module import them lazily', () => {
    const valueImport = /^import (?!type )[^']*from '\.\/(?:src\/lib\/worker\/)?scheduled'/mu
    for (const file of ['../../../worker.ts', './run-scheduled.ts']) {
      const source = readFileSync(resolve(import.meta.dirname, file), 'utf8')
      expect(source, file).not.toMatch(valueImport)
    }
    expect(readFileSync(resolve(import.meta.dirname, '../../../worker.ts'), 'utf8')).toContain(
      "load: () => import('./src/lib/worker/scheduled')"
    )
  })
})
