"use client";

import * as React from "react";
import { ShareNetwork } from "@phosphor-icons/react";

import { emitFx } from "@/components/phone/fx/fxBus";
import { burstFrom } from "@/components/phone/lib/confetti";
import { haptic } from "@/components/phone/lib/haptics";
import { Tap } from "@/components/phone/ui/Tap";
import { characterTitle, daysUntil, goalOptions, INTERESTS, personaOf, STAGES, vibeOf, vibeTitle, type Mood } from "./content";
import { Holo } from "./Holo";
import { shareCard, type CardData } from "./shareCard";
import { examName, type Answers } from "./state";
import { Cta } from "./ui";

const GRADIENTS: Record<string, [string, string, string]> = {
  hype: ["#ff7ac6", "#ff9a3d", "#d4ff3a"],
  coach: ["#ffc53d", "#ff9a3d", "#ff4d5e"],
  chill: ["#7cc7ff", "#b69cff", "#5cf2b5"],
  monk: ["#5cf2b5", "#7cc7ff", "#b69cff"],
};

const SHARE_LINES: Record<string, { mood: Mood; line: string }> = {
  shared: { mood: "excited", line: "Sent! Your friends are not ready." },
  downloaded: { mood: "happy", line: "Saved. Post it, legend." },
  copied: { mood: "smirk", line: "Brag text copied. Paste it anywhere." },
  cancelled: { mood: "calm", line: "No worries. It'll be here." },
  failed: { mood: "oops", line: "Sharing's shy in here. Screenshot it instead. 📸" },
};

export function stageLine(answers: Answers): string {
  if (answers.stage === "exam") {
    const exam = examName(answers) ?? "Exam";
    const days = daysUntil(answers.examDate);
    return days !== null && days >= 0 ? `${exam} · ${days} days to go` : `${exam} grind`;
  }
  return STAGES.find((stage) => stage.value === answers.stage)?.title ?? "";
}

/** The payoff: a shareable character card, then into the app. */
export function RevealStep({ answers, react, onGo }: {
  answers: Answers;
  react: (mood: Mood, line: string) => void;
  onGo: () => void;
}) {
  const card = React.useRef<HTMLDivElement>(null);
  const [sharing, setSharing] = React.useState(false);
  const vibe = vibeOf(answers.vibe);
  const persona = personaOf(answers.gender);
  const vibeName = vibeTitle(vibe, persona);
  const title = characterTitle(answers.chronotype, answers.enemy);
  const name = answers.name.trim() || "You";
  const goalEmoji = new Map(goalOptions(answers.stage, examName(answers)).map((goal) => [goal.label, goal.emoji]));
  const likes = answers.interests.map((label) => INTERESTS.find((item) => item.label === label)?.emoji).filter((emoji): emoji is string => Boolean(emoji));
  const line = stageLine(answers);

  // The card lands, then the confetti.
  React.useEffect(() => {
    const timer = window.setTimeout(() => {
      haptic("success");
      emitFx("success", card.current);
      burstFrom(card.current, 1.6);
    }, 520);
    return () => window.clearTimeout(timer);
  }, []);

  const share = async () => {
    if (sharing) return;
    setSharing(true);
    const data: CardData = {
      name,
      title,
      vibe: vibeName,
      her: persona === "her",
      vibeEmoji: vibe.emoji,
      goals: answers.goals,
      interests: likes,
      stageLine: line,
      colors: GRADIENTS[vibe.value] ?? GRADIENTS.hype,
    };
    const outcome = await shareCard(data, card.current);
    setSharing(false);
    const reply = SHARE_LINES[outcome];
    react(reply.mood, reply.line);
  };

  return (
    <div className="ob-step ob-reveal">
      <div className="ob-step-body ob-reveal-body">
        <h2 className="ob-title ob-reveal-title" data-ob-title tabIndex={-1}>Meet your JARVIS.</h2>
        <div
          ref={card}
          className="ob-char"
          data-vibe={vibe.value}
          role="img"
          aria-label={`Character card: ${name}, ${title}. Vibe: ${vibeName}. Main quests: ${answers.goals.join(", ")}. Day 1 streak.`}
        >
          <span className="ob-char-shine" aria-hidden="true" />
          <div className="ob-char-top" aria-hidden="true">
            <span className="ob-char-tag">JARVIS Public</span>
            <span className="ob-char-lvl">LVL 1</span>
          </div>
          <div className="ob-char-face" aria-hidden="true">
            <Holo mood={vibe.mood} size={92} />
          </div>
          <p className="ob-char-class" aria-hidden="true">{title}</p>
          <p className="ob-char-name" aria-hidden="true">{name}</p>
          <span className="ob-char-vibe" aria-hidden="true">{vibe.emoji} {vibeName}</span>
          {answers.goals.length > 0 && (
            <div className="ob-char-goals" aria-hidden="true">
              <span className="ob-char-tag">Main quests</span>
              <ol>
                {answers.goals.slice(0, 3).map((goal, index) => (
                  <li key={goal}>
                    <span className="ob-char-num">0{index + 1}</span>
                    <span>{goalEmoji.get(goal) ?? "⭐"} {goal}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}
          <div className="ob-char-foot" aria-hidden="true">
            <span className="ob-char-streak">🔥 Day 1</span>
            <span className="ob-char-likes">
              <span>{likes.slice(0, 5).join(" ")}</span>
              {line && <small>{line}</small>}
            </span>
          </div>
        </div>
      </div>
      <div className="ob-step-foot ob-reveal-foot">
        <Tap className="ob-share" feel="tap" squish={0.94} disabled={sharing} aria-busy={sharing || undefined} onClick={() => void share()}>
          <ShareNetwork size={20} weight="bold" aria-hidden="true" />
          {sharing ? "Making it…" : "Share"}
        </Tap>
        <Cta onClick={onGo}>Let&apos;s go</Cta>
      </div>
    </div>
  );
}
