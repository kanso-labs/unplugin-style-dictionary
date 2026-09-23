import { describe, expect, it, vi } from 'vitest'

import { createScheduler } from '../src/scheduler.ts'

// The scheduler on its own, with no bundler behind it. Every case uses a
// debounce short enough to keep the suite quick. What a case waits for, it
// polls for, so a slow runner makes it slower rather than wrong; a fixed wait
// is only ever used to show that something did not happen.
const DEBOUNCE_MS = 5

const settle = async (ms: number) => {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

const until = async (condition: () => boolean) => {
  const deadline = Date.now() + 2000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await settle(1)
  }
}

// A run that records the reason it was handed and finishes on the next tick.
const recordingInto = (reasons: string[]) => async (reason: string) => {
  reasons.push(reason)
  await Promise.resolve()
}

describe('createScheduler', () => {
  it('waits for a burst to go quiet, then runs once for its last reason', async () => {
    // Spread over time rather than fired at once, because a burst on one tick
    // collapses through the in-flight chain alone — it cannot tell a trailing
    // debounce from none. Fake timers, so the spacing is exact on any runner.
    vi.useFakeTimers()
    try {
      const reasons: string[] = []
      const schedule = createScheduler({
        debounceMs: 50,
        isClosed: () => false,
        run: recordingInto(reasons),
      })

      // Each trigger lands inside the window the previous one opened.
      const triggers = [schedule('a.json')]
      for (const reason of ['b.json', 'c.json', 'd.json']) {
        await vi.advanceTimersByTimeAsync(30)
        triggers.push(schedule(reason))
      }
      expect(reasons).toEqual([])

      await vi.advanceTimersByTimeAsync(50)
      await Promise.all(triggers)

      expect(reasons).toEqual(['d.json'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('queues one follow-up for triggers that arrive mid-run, and never runs two at once', async () => {
    const started: string[] = []
    const finish: Array<() => void> = []
    let running = 0
    let overlapped = false

    const schedule = createScheduler({
      debounceMs: DEBOUNCE_MS,
      isClosed: () => false,
      run: async (reason) => {
        started.push(reason)
        running++
        if (running > 1) overlapped = true
        await new Promise<void>((resolve) => {
          finish.push(resolve)
        })
        running--
      },
    })

    const first = schedule('a.json')
    await until(() => started.length === 1)
    expect(started).toEqual(['a.json'])

    // Two more while the first is still running, past their own debounce.
    const second = schedule('b.json')
    const third = schedule('c.json')
    await settle(DEBOUNCE_MS * 4)
    expect(started).toEqual(['a.json'])

    finish[0]?.()
    await first
    await settle(DEBOUNCE_MS * 4)
    expect(started).toEqual(['a.json', 'c.json'])

    finish[1]?.()
    await Promise.all([second, third])
    await settle(DEBOUNCE_MS * 4)

    expect(started).toEqual(['a.json', 'c.json'])
    expect(overlapped).toBe(false)
  })

  it('rejects every trigger a failed run covered, and runs the next one', async () => {
    let fail = true
    const schedule = createScheduler({
      debounceMs: DEBOUNCE_MS,
      isClosed: () => false,
      run: async () => {
        await Promise.resolve()
        if (fail) throw new Error('the build failed')
      },
    })

    const first = schedule('a.json')
    const second = schedule('b.json')

    await expect(first).rejects.toThrow('the build failed')
    await expect(second).rejects.toThrow('the build failed')

    // A failure does not wedge the chain: the next trigger gets a run of its
    // own, and hears that it worked.
    fail = false
    await expect(schedule('c.json')).resolves.toBeUndefined()
  })

  it('declines a trigger once the host has closed, without running anything', async () => {
    const reasons: string[] = []
    const schedule = createScheduler({
      debounceMs: DEBOUNCE_MS,
      isClosed: () => true,
      run: recordingInto(reasons),
    })

    await expect(schedule('a.json')).resolves.toBeUndefined()
    await settle(DEBOUNCE_MS * 4)

    expect(reasons).toEqual([])
  })

  it('still runs a trigger that arrived before the host closed', async () => {
    // Deliberate, and recorded in AGENTS.md: the rebuild was asked for while
    // the project was still whole, so the close declines only what comes
    // after it.
    let closed = false
    const reasons: string[] = []
    const schedule = createScheduler({
      debounceMs: DEBOUNCE_MS,
      isClosed: () => closed,
      run: recordingInto(reasons),
    })

    const pending = schedule('a.json')
    closed = true
    await pending

    expect(reasons).toEqual(['a.json'])
  })
})
