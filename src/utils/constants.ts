/**
 * 枚举与展示常量。
 * 领域类型（Season/SmellType/Emotion/SmellMemory）定义在台账核心，这里统一再导出，
 * 保证既有导入路径（../utils/constants）不变。
 */
import type { Season, SmellType, Emotion } from '../lib/ledger/types';

export type { Season, SmellType, Emotion, SmellMemory } from '../lib/ledger/types';

export const SEASONS: { value: Season; label: string; emoji: string }[] = [
  { value: 'spring', label: '春', emoji: '🌸' },
  { value: 'summer', label: '夏', emoji: '☀️' },
  { value: 'autumn', label: '秋', emoji: '🍂' },
  { value: 'winter', label: '冬', emoji: '❄️' },
];

export const SMELL_TYPES: { value: SmellType; label: string; emoji: string; color: string }[] = [
  { value: 'woody', label: '木质', emoji: '🪵', color: '#8B5A2B' },
  { value: 'floral', label: '花香', emoji: '🌺', color: '#C06C84' },
  { value: 'fruity', label: '果香', emoji: '🍑', color: '#F67280' },
  { value: 'earthy', label: '泥土', emoji: '🌱', color: '#6B8E23' },
  { value: 'spicy', label: '辛香', emoji: '🌶️', color: '#CD5C5C' },
  { value: 'sweet', label: '甜香', emoji: '🍯', color: '#D4A574' },
  { value: 'musty', label: '霉味', emoji: '🍄', color: '#8B7355' },
  { value: 'fresh', label: '清新', emoji: '🍃', color: '#7DA08C' },
  { value: 'burnt', label: '焦味', emoji: '🔥', color: '#4A3728' },
  { value: 'other', label: '其他', emoji: '✨', color: '#9B8AA6' },
];

export const EMOTIONS: { value: Emotion; label: string; emoji: string; bg: string; text: string }[] = [
  { value: 'warm', label: '温暖', emoji: '🤗', bg: 'bg-ochre-100', text: 'text-ochre-600' },
  { value: 'nostalgic', label: '怀旧', emoji: '📜', bg: 'bg-lavender-300/40', text: 'text-lavender-600' },
  { value: 'peaceful', label: '宁静', emoji: '🌊', bg: 'bg-moss-100', text: 'text-moss-600' },
  { value: 'melancholy', label: '忧郁', emoji: '🌧️', bg: 'bg-paper-300', text: 'text-ink-700' },
  { value: 'joyful', label: '愉悦', emoji: '🎉', bg: 'bg-paper-200', text: 'text-brick-500' },
  { value: 'uncomfortable', label: '不适', emoji: '😣', bg: 'bg-brick-400/20', text: 'text-brick-600' },
  { value: 'surprising', label: '惊喜', emoji: '✨', bg: 'bg-lavender-300/40', text: 'text-lavender-600' },
];

export const HUMIDITY_LABELS: Record<number, string> = {
  1: '极干',
  3: '偏干',
  5: '适中',
  7: '偏湿',
  10: '极湿',
};

export function getSeasonInfo(s: Season) {
  return SEASONS.find(x => x.value === s)!;
}
export function getSmellTypeInfo(t: SmellType) {
  return SMELL_TYPES.find(x => x.value === t)!;
}
export function getEmotionInfo(e: Emotion) {
  return EMOTIONS.find(x => x.value === e)!;
}
