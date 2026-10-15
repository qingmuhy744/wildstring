import { useEffect, useState } from 'react';

const storageKey = 'wildstring:last-library-motto';
const mottos = [
  '熟悉的旋律，值得再听一遍。',
  '把音量留给音乐，把自己留给热爱。',
  '日子照常向前，吉他照样响。',
  '世界催你赶路，音乐陪你绕远。',
  '有些话，交给失真的吉他。',
  '旧唱片里，还有没熄灭的火。',
  '不必合拍，自有回响。',
  '生活偶尔失真，热爱一直在场。',
  '把疲惫放下，让鼓点接着走。',
  '总有一段前奏，让你重新抬起头。',
  '那些没说出口的，都在旋律里。',
  '听见熟悉的声音，也听见自己。',
  '再普通的一天，也该有一段好前奏。',
  '不赶下一首，好好听完这一首。',
  '让今天的风，吹进昨天的歌。',
  '城市还没睡，心里的鼓点还在。',
  '在喧闹的世界，留一首自己的歌。',
  '路可以慢慢走，歌可以大声唱。',
  '有些声音，越过时间还滚烫。',
  '人生不必静音，热爱无需散场。',
  '弦还在响，故事就没结束。',
  '放一张老专辑，和从前的自己碰个杯。',
  '世界有它的规矩，你有你的节奏。',
  '把平淡的日子，弹出一点棱角。',
];

export function useLibraryMotto() {
  const [motto] = useState(() => {
    let previous = '';
    try {
      previous = localStorage.getItem(storageKey) || '';
    } catch {
      // The copy still works when browser storage is unavailable.
    }
    const choices = mottos.filter((item) => item !== previous);
    return choices[Math.floor(Math.random() * choices.length)];
  });
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, motto);
    } catch {
      // Storage is optional; playback and browsing must remain available.
    }
  }, [motto]);
  return motto;
}
