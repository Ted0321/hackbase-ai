import { useMemo, useState } from "react";
import "./styles.css";
import { actionCards, sampleNotice, sourceSnippets, uncertaintyItems } from "./data";

export default function Page() {
  const [noticeText, setNoticeText] = useState(sampleNotice.text);
  const [grade, setGrade] = useState(sampleNotice.grade);
  const [familyContext, setFamilyContext] = useState(sampleNotice.familyContext);
  const [selectedSnippetId, setSelectedSnippetId] = useState(actionCards[0].sourceSnippetId);
  const grouped = useMemo(
    () => ({
      today: actionCards.filter((card) => card.status === "today"),
      thisWeek: actionCards.filter((card) => card.status === "this_week"),
      ask: actionCards.filter((card) => card.status === "ask"),
    }),
    [],
  );

  return (
    <main className="otayori-shell">
      <header className="hero">
        <div>
          <p className="eyebrow">Prodia Concept Artifact</p>
          <h1>おたよりルート</h1>
          <p>学校や自治体のお知らせを、家庭ごとの行動ルート、確認質問、原文根拠に分けます。</p>
        </div>
        <aside className="safety-note">公式文書の代替ではありません。原文にない内容は判断せず、確認待ちとして残します。</aside>
      </header>
      <section className="workspace" aria-label="おたよりルート ワークスペース">
        <section className="input-panel" aria-label="入力">
          <div className="panel-head">
            <span>Input</span>
            <button
              type="button"
              onClick={() => {
                setNoticeText(sampleNotice.text);
                setGrade(sampleNotice.grade);
                setFamilyContext(sampleNotice.familyContext);
              }}
            >
              サンプル読み込み
            </button>
          </div>
          <label>
            お知らせ本文
            <textarea value={noticeText} onChange={(event) => setNoticeText(event.target.value)} />
          </label>
          <div className="field-row">
            <label>
              学年
              <input value={grade} onChange={(event) => setGrade(event.target.value)} />
            </label>
            <label>
              家庭メモ
              <input value={familyContext} onChange={(event) => setFamilyContext(event.target.value)} />
            </label>
          </div>
          <div className="source-box">
            <h2>原文根拠</h2>
            {sourceSnippets.map((snippet) => (
              <button
                key={snippet.id}
                type="button"
                className={snippet.id === selectedSnippetId ? "snippet active" : "snippet"}
                onClick={() => setSelectedSnippetId(snippet.id)}
              >
                <strong>{snippet.label}</strong>
                <span>{snippet.text}</span>
                <small>{snippet.whyUsed}</small>
              </button>
            ))}
          </div>
        </section>
        <section className="route-panel" aria-label="行動ルート">
          <div className="panel-title">
            <span>Route</span>
            <h2>家庭の次アクション</h2>
          </div>
          <div className="route-columns">
            <RouteColumn title="今日やる" cards={grouped.today} onPick={setSelectedSnippetId} />
            <RouteColumn title="今週やる" cards={grouped.thisWeek} onPick={setSelectedSnippetId} />
            <RouteColumn title="確認待ち" cards={grouped.ask} onPick={setSelectedSnippetId} />
          </div>
        </section>
        <aside className="uncertainty-panel" aria-label="不明点">
          <div className="panel-title">
            <span>Unknown</span>
            <h2>まだ判断しないこと</h2>
          </div>
          {uncertaintyItems.map((item) => (
            <article key={item.id} className="uncertainty-card">
              <strong>{item.question}</strong>
              <p>{item.whyUnknown}</p>
              <small>確認先: {item.suggestedAskTarget}</small>
            </article>
          ))}
        </aside>
      </section>
    </main>
  );
}

function RouteColumn({
  title,
  cards,
  onPick,
}: {
  title: string;
  cards: typeof actionCards;
  onPick: (id: string) => void;
}) {
  return (
    <div className="route-column">
      <h3>{title}</h3>
      {cards.map((card) => (
        <button key={card.id} type="button" className="action-card" onClick={() => onPick(card.sourceSnippetId)}>
          <span>{card.ownerLabel}</span>
          <strong>{card.title}</strong>
          <small>{card.dueLabel}</small>
          <p>{card.reason}</p>
          <em>根拠を見る</em>
        </button>
      ))}
    </div>
  );
}
