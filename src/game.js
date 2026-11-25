import { randomInt } from 'node:crypto';

export class GameError extends Error {}
export const SUITS = ['♠', '♥', '♣', '♦'];
export const SUIT_NAMES = ['پیک', 'دل', 'گشنیز', 'خشت'];
const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

export function suit(card) {
  return Math.floor(card / 13);
}

export function cardLabel(card) {
  return SUITS[suit(card)] + ranks[card % 13];
}

function shuffledDeck() {
  const deck = Array.from({ length: 52 }, (_, i) => i);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function newRound(state, notice = null) {
  Object.assign(state, {
    phase: 'cut', turn: (state.ruler + 2) % 4, deck: shuffledDeck(),
    hands: [[], [], [], []], trump: null, trick: [], tricks: [0, 0],
    lastWinner: null, cut: false, bam: false, votes: [], notice,
    round: state.round + 1, v: state.v + 1,
  });
}

export function startGame(players) {
  const first = randomInt(4);
  let ruler = null;
  let partner = null;
  while (partner === null) {
    for (const [index, card] of shuffledDeck().entries()) {
      if (card % 13 !== 12) continue;
      const seat = (first + index) % 4;
      if (ruler === null) ruler = seat;
      else if (seat !== ruler) {
        partner = seat;
        break;
      }
    }
  }
  const opponents = [0, 1, 2, 3].filter(s => s !== ruler && s !== partner);
  const seats = [players[ruler], players[opponents[0]], players[partner], players[opponents[1]]];
  const state = {
    ruler: 0, score: [0, 0], round: 0, v: 0,
    lastRound: null, winner: null, reason: null, notice: null,
  };
  newRound(state);
  return { seats, state };
}

function packets(state, count) {
  for (let offset = 0; offset < 4; offset++) {
    const seat = (state.ruler + offset) % 4;
    state.hands[seat].push(...state.deck.splice(0, count));
  }
}

export function canRulerRedeal(state) {
  return state.phase === 'choose' && !state.cut && state.hands[state.ruler].every(card => card % 13 <= 8);
}

export function voteOpen(state) {
  return state.phase === 'play' && state.tricks[0] + state.tricks[1] === 0 && !state.trick.length;
}

export function voteRedeal(state, seat) {
  if (!voteOpen(state) || state.votes.includes(seat)) {
    throw new GameError('رأی تکراری است یا اولین برگ بازی شده.');
  }
  if (state.hands[state.ruler].some(card => suit(card) === state.trump)) {
    throw new GameError('این دست مشمول پخش دوباره با رأی نیست.');
  }
  state.votes.push(seat);
  if (state.votes.length === 2) newRound(state, 'دو بازیکن به پخش دوباره رأی دادند.');
}

export function legalCards(state, seat) {
  const hand = state.hands[seat];
  if (!state.trick.length) return hand;
  const lead = suit(state.trick[0][1]);
  const follows = hand.filter(card => suit(card) === lead);
  return follows.length ? follows : hand;
}

function strength(card, lead, trump) {
  if (suit(card) === trump) return 26 + card % 13;
  if (suit(card) === lead) return 13 + card % 13;
  return 0;
}

function trickWinner(trick, trump) {
  const lead = suit(trick[0][1]);
  let best = -1;
  let winner;
  for (const [seat, card] of trick) {
    const value = strength(card, lead, trump);
    if (value > best) {
      best = value;
      winner = seat;
    }
  }
  return winner;
}

export function finishGame(state, winner, reason) {
  Object.assign(state, { phase: 'ended', winner, reason, v: state.v + 1 });
}

function roundWon(state, team, points) {
  state.score[team] += points;
  state.lastRound = { team, points, tricks: state.tricks };
  if (state.score[team] >= 7) {
    finishGame(state, team, 'score');
    return;
  }
  if (state.ruler % 2 !== team) state.ruler = (state.ruler + 1) % 4;
  newRound(state);
}

function settleTrick(state) {
  const winner = trickWinner(state.trick, state.trump);
  const team = winner % 2;
  state.lastWinner = winner;
  state.trick = [];
  state.turn = winner;
  state.tricks[team]++;
  if (state.bam) {
    const leader = state.tricks[0] >= 7 ? 0 : 1;
    if (state.tricks[leader] === 13) {
      state.lastRound = { team: leader, points: 0, tricks: state.tricks };
      finishGame(state, leader, 'bam');
      return;
    }
    if (state.tricks[1 - leader]) roundWon(state, leader, leader === state.ruler % 2 ? 2 : 3);
    return;
  }
  if (state.tricks[team] === 7) {
    if (state.tricks[1 - team] === 0) state.phase = 'bam';
    else roundWon(state, team, 1);
  }
}

export function playAction(state, seat, action, value) {
  if (state.turn !== seat || state.phase === 'ended') throw new GameError('الان نوبت تو نیست.');
  const version = state.v;
  switch (state.phase) {
    case 'cut': {
      if (action !== 'cut' || ![0, 13, 26, 39].includes(value)) throw new GameError('یکی از گزینه‌های کوپ را انتخاب کن.');
      if (value) state.deck.push(...state.deck.splice(0, value));
      state.cut = Boolean(value);
      packets(state, 5);
      state.phase = 'choose';
      state.turn = state.ruler;
      break;
    }
    case 'choose': {
      if (action === 'redeal' && canRulerRedeal(state)) {
        newRound(state, 'حاکم با برگ‌های پایین درخواست پخش دوباره کرد.');
        return;
      }
      if (action !== 'trump' || !SUITS[value]) throw new GameError('حاکم باید خال حکم را انتخاب کند.');
      state.trump = value;
      packets(state, 4);
      packets(state, 4);
      if (state.hands.some((hand, index) => index % 2 !== seat % 2 && !hand.some(card => suit(card) === value))) {
        newRound(state, 'یکی از حریف‌ها خال حکم نداشت. دوباره کارت پخش می‌شود.');
        return;
      }
      state.phase = 'play';
      state.notice = null;
      break;
    }
    case 'bam':
      if (action !== 'bam' || ![0, 1].includes(value)) throw new GameError('کت را ثبت کن یا برای بام ادامه بده.');
      if (!value) {
        roundWon(state, seat % 2, seat % 2 === state.ruler % 2 ? 2 : 3);
        return;
      }
      state.bam = true;
      state.phase = 'play';
      break;
    case 'play':
      if (action !== 'card' || !legalCards(state, seat).includes(value)) {
        throw new GameError('این برگ با خال زمینه یا دست فعلی سازگار نیست.');
      }
      state.hands[seat].splice(state.hands[seat].indexOf(value), 1);
      state.trick.push([seat, value]);
      state.turn = (seat + 1) % 4;
      if (state.trick.length === 4) settleTrick(state);
      break;
  }
  if (state.v === version) state.v++;
}

function suggestTrump(hand) {
  const weights = [0, 0, 0, 0];
  for (const card of hand) weights[suit(card)] += 15 + card % 13;
  return weights.indexOf(Math.max(...weights));
}

function suggestCard(state, seat) {
  const weight = card => Number(suit(card) === state.trump) * 13 + card % 13;
  const cards = [...legalCards(state, seat)].sort((a,b) => weight(a) - weight(b));
  if (!state.trick.length) return cards.at(-1);
  if (trickWinner(state.trick, state.trump) % 2 !== seat % 2) {
    const winner = cards.find(card => trickWinner([...state.trick, [seat, card]], state.trump) === seat);
    if (winner !== undefined) return winner;
  }
  return cards[0];
}

export function runBots(state, seats) {
  for (let count = 0; count < 150 && state.phase !== 'ended' && seats[state.turn] === null; count++) {
    const seat = state.turn;
    switch (state.phase) {
      case 'cut': playAction(state, seat, 'cut', 26); break;
      case 'choose': playAction(state, seat, 'trump', suggestTrump(state.hands[seat])); break;
      case 'bam': playAction(state, seat, 'bam', 0); break;
      case 'play': playAction(state, seat, 'card', suggestCard(state, seat)); break;
    }
  }
}
