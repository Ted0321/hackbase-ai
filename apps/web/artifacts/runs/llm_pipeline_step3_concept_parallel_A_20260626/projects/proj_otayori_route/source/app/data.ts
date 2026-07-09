export const sampleNotice = {
  grade: "小学3年",
  familyContext: "平日は保護者Aが夕方に確認。アレルギー確認が必要。",
  text: `校外学習のお知らせ
6月30日(火)に中央公園へ校外学習へ行きます。参加同意書は6月27日(金)までに担任へ提出してください。
持ち物は水筒、帽子、筆記用具、雨具です。昼食の有無は後日連絡します。
食物アレルギーや体調面で配慮が必要な場合は、連絡帳でお知らせください。`,
};

export const sourceSnippets = [
  {
    id: "src_deadline",
    label: "提出期限",
    text: "参加同意書は6月27日(金)までに担任へ提出してください。",
    whyUsed: "期限と提出先が明記されているため、今日の行動カードに変換。",
  },
  {
    id: "src_items",
    label: "持ち物",
    text: "持ち物は水筒、帽子、筆記用具、雨具です。",
    whyUsed: "準備物が列挙されているため、今週の準備カードに変換。",
  },
  {
    id: "src_lunch",
    label: "未確定情報",
    text: "昼食の有無は後日連絡します。",
    whyUsed: "原文で未確定とされているため、確認待ちに分離。",
  },
  {
    id: "src_allergy",
    label: "家庭条件",
    text: "食物アレルギーや体調面で配慮が必要な場合は、連絡帳でお知らせください。",
    whyUsed: "家庭メモと関連するため、確認質問に変換。",
  },
];

export const actionCards = [
  {
    id: "act_consent",
    status: "today",
    title: "参加同意書を確認して提出準備",
    ownerLabel: "保護者",
    dueLabel: "6月27日(金)まで",
    reason: "提出期限と提出先が原文にあるため、最優先の行動。",
    sourceSnippetId: "src_deadline",
    confidence: "high",
  },
  {
    id: "act_items",
    status: "this_week",
    title: "水筒・帽子・筆記用具・雨具をそろえる",
    ownerLabel: "家庭",
    dueLabel: "前日まで",
    reason: "持ち物が明記されており、購入や準備が必要な可能性がある。",
    sourceSnippetId: "src_items",
    confidence: "high",
  },
  {
    id: "act_lunch",
    status: "ask",
    title: "昼食の有無は後続連絡を待つ",
    ownerLabel: "確認待ち",
    dueLabel: "後日",
    reason: "原文が未確定としているため、AIが断定しない。",
    sourceSnippetId: "src_lunch",
    confidence: "medium",
  },
  {
    id: "act_allergy",
    status: "ask",
    title: "アレルギー配慮を連絡帳で相談",
    ownerLabel: "保護者",
    dueLabel: "早めに確認",
    reason: "家庭メモと原文の配慮連絡が一致している。",
    sourceSnippetId: "src_allergy",
    confidence: "medium",
  },
] as const;

export const uncertaintyItems = [
  {
    id: "unk_lunch",
    question: "昼食は必要か",
    whyUnknown: "原文が後日連絡としており、現時点では判断できない。",
    suggestedAskTarget: "学校からの続報",
  },
  {
    id: "unk_weather",
    question: "雨天時の実施判断",
    whyUnknown: "雨具は指定されているが、中止・延期条件は書かれていない。",
    suggestedAskTarget: "担任または学校のお知らせ",
  },
];
