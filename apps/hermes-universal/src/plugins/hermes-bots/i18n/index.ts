/**
 * Bot Mode's own locale bundles, registered through `ctx.i18n.register`.
 *
 * ZERO keys are added to core `en.ts`: a plugin ships its own copy, scoped like
 * its storage, and `check:i18n` never sees a key it has to account for.
 *
 * The WIRE strings are not here and never will be — the room envelope, the
 * `Message from 🤖 …` prefix and `(pass)` are read by a MODEL, and translating
 * them would change every agent's behaviour with the app's language setting.
 */

import type { PluginLocaleBundles } from '@hermes/plugin-sdk'

const en = {
  errors: {
    full: "This bot's settings are full — remove a room to make space.",
    noProtocol: 'This gateway does not support agent-to-agent messages.',
    partialWrite: 'Some agents did not accept the room change.',
    unreachable: 'That machine is unreachable right now.'
  },
  room: {
    disband: 'Disband…',
    disbandBody: 'It will disappear from every machine. The agents keep their own transcripts.',
    disbandTitle: 'Disband this room?',
    empty: 'Nothing said yet.',
    localPicture: 'The room picture is saved on this device.',
    memberBusy: 'still working',
    memberNeedsYou: 'needs you',
    memberStranded: 'took too long — its reply will be picked up',
    pausedBackground: 'Paused — reopen Hermes to continue.',
    pausedOffline: 'Paused — the gateway is offline.',
    placeholder: 'Message the room — @mention to address one agent',
    running: 'running…',
    send: 'Send',
    thinking: 'thinking…',
    tooManyMembers: (limit: number) => `A room holds at most ${limit} agents.`,
    tooManyRemote: (limit: number) => `At most ${limit} agents in a room may live on other machines.`
  },
  roster: {
    agents: 'Agents',
    empty: 'No agents yet.',
    hide: 'Hide from roster',
    newAgent: 'New agent',
    openChat: 'Open chat',
    retry: 'Retry',
    rooms: 'Rooms',
    search: 'Find an agent',
    show: 'Show in roster',
    showHidden: 'Show hidden agents',
    title: 'Bots'
  },
  routines: {
    add: 'Add routine',
    empty: 'No routines yet.',
    name: 'Name',
    pick: 'Pick an agent to see its routines.',
    prompt: 'What should it do?',
    schedule: 'Schedule (e.g. every 30m)',
    title: 'Routines'
  }
}

/**
 * The other four locales fall back to English for now, deliberately and
 * visibly: shipping machine-translated agent copy reads worse than English, and
 * the fallback is the app's own documented behaviour for a missing key rather
 * than a hole. Replacing a bundle is one object.
 */
export const bundles: PluginLocaleBundles = { en }
