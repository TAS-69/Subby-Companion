export const catalog = {
  sub: ['channel.subscribe', '1', 'channel:read:subscriptions'],
  resub: ['channel.subscription.message', '1', 'channel:read:subscriptions'],
  gift: ['channel.subscribe', '1', 'channel:read:subscriptions'],
  gift_batch: ['channel.subscription.gift', '1', 'channel:read:subscriptions'],
  bits: ['channel.cheer', '1', 'bits:read'],
  reward: ['channel.channel_points_custom_reward_redemption.add', '1', 'channel:read:redemptions'],
  raid: ['channel.raid', '1', ''],
  follow: ['channel.follow', '2', 'moderator:read:followers'],
  hype_begin: ['channel.hype_train.begin', '2', 'channel:read:hype_train'],
  hype_progress: ['channel.hype_train.progress', '2', 'channel:read:hype_train'],
  hype_end: ['channel.hype_train.end', '2', 'channel:read:hype_train'],
  poll: ['channel.poll.end', '1', 'channel:read:polls'],
  prediction: ['channel.prediction.end', '1', 'channel:read:predictions'],
  moderator_add: ['channel.moderator.add', '1', 'moderation:read'],
  moderator_remove: ['channel.moderator.remove', '1', 'moderation:read'],
  vip_add: ['channel.vip.add', '1', 'channel:read:vips'],
  vip_remove: ['channel.vip.remove', '1', 'channel:read:vips'],
  first_chat: ['channel.chat.message', '1', 'user:read:chat'],
  bot: ['channel.chat.message', '1', 'user:read:chat'],
  ban: ['channel.ban', '1', 'channel:moderate'],
  unban: ['channel.unban', '1', 'channel:moderate']
};

export function selectedEvents(input = []) {
  if (!Array.isArray(input) || input.length > 30 || input.some(e => !Object.hasOwn(catalog, e))) throw new Error('Choose supported event types.');
  return [...new Set(['sub', 'resub', 'gift', ...input])];
}

export function scopes(events) {
  const list = events.map(e => catalog[e]?.[2]).filter(Boolean);
  if (events.includes('bot')) list.push('user:write:chat');
  return [...new Set(list)].sort();
}

export function subscriptions(events, channel) {
  const definitions = new Map();
  for (const event of selectedEvents(events)) {
    const [type, version] = catalog[event];
    const condition = type === 'channel.raid' ? { to_broadcaster_user_id: channel } : { broadcaster_user_id: channel };
    if (type === 'channel.follow') condition.moderator_user_id = channel;
    if (type === 'channel.chat.message') condition.user_id = channel;
    definitions.set(type, { type, version, condition });
  }
  return [...definitions.values()];
}

export function clean(value, limit = 500) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u00a7\u202a-\u202e\u2066-\u2069]/g, '').slice(0, limit);
}

export function normalize(message) {
  const { metadata: meta, payload } = message;
  const event = payload?.event;
  if (!event || !meta?.message_id) return null;
  let kind = Object.keys(catalog).find(k => catalog[k][0] === payload.subscription?.type);
  if (!kind || kind === 'bot') return null;
  if (kind === 'sub' && event.is_gift) kind = 'gift';
  const details = { login: clean(event.user_login ?? event.chatter_user_login ?? event.from_broadcaster_user_login, 64) };
  const add = (key, value) => { if (value !== undefined && value !== null) details[key] = clean(value); };
  add('streak', event.streak_months);
  add('gift_count', kind === 'gift_batch' ? event.total : kind === 'gift' ? 1 : undefined);
  add('gifter', kind === 'gift_batch' ? (event.is_anonymous ? 'Anonymous' : event.user_name) : undefined);
  add('gifter_login', kind === 'gift_batch' && !event.is_anonymous ? event.user_login : undefined);
  add('bits', event.bits);
  add('raid_viewers', event.viewers);
  add('reward', event.reward?.title);
  add('reward_id', event.reward?.id);
  add('user_input', event.user_input);
  add('hype_level', event.level);
  add('hype_total', kind.startsWith('hype_') ? event.total : undefined);
  add('hype_progress', kind.startsWith('hype_') ? event.progress : undefined);
  add('hype_goal', kind.startsWith('hype_') ? event.goal : undefined);
  add('poll', kind === 'poll' ? event.title : undefined);
  add('prediction', kind === 'prediction' ? event.title : undefined);
  add('outcome', event.outcomes?.find(o => o.id === event.winning_outcome_id)?.title);
  add('ban_expires', event.ends_at);
  if (kind === 'poll') {
    const choices = event.choices ?? [], highest = Math.max(0, ...choices.map(c => c.votes));
    add('outcome', choices.filter(c => c.votes === highest).map(c => c.title).join(', ')); add('poll_status', event.status);
  }
  if (kind === 'prediction') add('prediction_status', event.status);
  return {
    messageId: clean(meta.message_id, 128),
    broadcasterId: clean(event.broadcaster_user_id ?? event.to_broadcaster_user_id, 64),
    userId: clean(event.user_id ?? event.chatter_user_id ?? event.from_broadcaster_user_id, 64),
    name: clean(event.is_anonymous ? 'Anonymous' : event.user_name ?? event.chatter_user_name ?? event.from_broadcaster_user_name ?? 'Twitch', 64),
    kind, tier: clean(event.tier ?? '1000', 16),
    months: Math.max(0, Math.min(10000, Number(event.cumulative_months ?? 1) || 1)),
    receivedAt: new Date(meta.message_timestamp).toISOString(), details
  };
}
