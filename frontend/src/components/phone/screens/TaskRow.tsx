"use client";

import * as React from "react";
import { motion, useMotionValue, useTransform, type PanInfo } from "framer-motion";
import { Check, Clock, Pause, Play, Tag } from "@phosphor-icons/react";

import { parseLocal } from "@/lib/utils";
import type { Task } from "@/types";
import { isOverdueTask } from "../lib/derive";
import { haptic } from "../lib/haptics";
import { dayDelta, when } from "../lib/time";
import { useAppData, useFinishAction } from "../PhoneContext";
import { Chip, Sticker, stagger } from "../ui/Bits";

const THRESHOLD = 92;

/**
 * One task. Swipe right to finish it, left to start or pause it; tap the
 * circle to finish, tap the text to edit.
 *
 * Memoised with `done` passed in, so ticking one task re-renders that row
 * and not the whole list. It rises in with a CSS animation and collapses out
 * through AnimatePresence.
 */
export const TaskRow = React.memo(function TaskRow({ task, done, onEdit, index = 0 }: {
  task: Task;
  done: boolean;
  onEdit: (task: Task) => void;
  index?: number;
}) {
  const finish = useFinishAction();
  const { app } = useAppData();
  const checkRef = React.useRef<HTMLButtonElement>(null);
  const armed = React.useRef<"done" | "doing" | null>(null);
  const x = useMotionValue(0);
  const doneReveal = useTransform(x, [0, 36, THRESHOLD], [0, 0.55, 1]);
  const doingReveal = useTransform(x, [0, -36, -THRESHOLD], [0, 0.55, 1]);
  const doneIcon = useTransform(x, [0, THRESHOLD, THRESHOLD + 50], [0.5, 1, 1.25]);
  const doingIcon = useTransform(x, [0, -THRESHOLD, -THRESHOLD - 50], [0.5, 1, 1.25]);

  const doing = task.status === "IN_PROGRESS";
  const due = parseLocal(task.due_date);
  const overdue = isOverdueTask(task);
  const today = due !== null && !overdue && dayDelta(due) === 0;

  const complete = () => {
    if (!done) finish(task, checkRef.current);
  };
  const toggleDoing = () => {
    haptic("toggle-on");
    void app.handleToggleTask(task.id, doing ? "PENDING" : "IN_PROGRESS");
  };

  const onDrag = (_: unknown, info: PanInfo) => {
    const next = info.offset.x > THRESHOLD ? "done" : info.offset.x < -THRESHOLD ? "doing" : null;
    if (next !== armed.current) {
      armed.current = next;
      if (next) haptic("select");
    }
  };
  const onDragEnd = (_: unknown, info: PanInfo) => {
    const intent = armed.current;
    armed.current = null;
    if (intent === "done" || info.velocity.x > 900) complete();
    else if (intent === "doing" || info.velocity.x < -900) toggleDoing();
  };

  return (
    <motion.li
      className="ph-task ph-rise"
      style={stagger(index)}
      data-done={done}
      exit={{ opacity: 0, height: 0, marginBottom: 0, transform: "scale(0.96)", transition: { duration: 0.26, ease: [0.4, 0, 0.2, 1] } }}
    >
      <div className="ph-task-under" aria-hidden="true">
        <motion.span className="ph-task-under-done" style={{ opacity: doneReveal }}>
          <motion.span style={{ scale: doneIcon }}><Check size={22} weight="bold" /></motion.span> DONE
        </motion.span>
        <motion.span className="ph-task-under-doing" style={{ opacity: doingReveal }}>
          {doing ? "PAUSE" : "START"} <motion.span style={{ scale: doingIcon }}>{doing ? <Pause size={20} weight="fill" /> : <Play size={20} weight="fill" />}</motion.span>
        </motion.span>
      </div>
      <motion.div
        className="ph-task-card"
        style={{ x, touchAction: "pan-y" }}
        drag="x"
        dragDirectionLock
        dragConstraints={{ left: 0, right: 0 }}
        dragElastic={0.62}
        dragTransition={{ bounceStiffness: 520, bounceDamping: 32 }}
        onDrag={onDrag}
        onDragEnd={onDragEnd}
      >
        <button
          ref={checkRef}
          type="button"
          className="ph-check ph-tap"
          style={{ "--squish": 0.8 } as React.CSSProperties}
          data-status={done ? "COMPLETED" : task.status}
          aria-label={`Finish: ${task.title}`}
          onClick={complete}
        >
          <span className="ph-check-fill" />
          <svg viewBox="0 0 24 24" className="ph-check-mark" aria-hidden="true">
            <path d="M6 12.5l4 4 8-9" pathLength={1} />
          </svg>
        </button>
        <button type="button" className="ph-task-body" onClick={() => onEdit(task)} aria-label={`Edit: ${task.title}`}>
          <strong className="ph-task-title">{task.title}</strong>
          <span className="ph-task-meta">
            {doing && <Chip tone="sky" icon={<Play size={11} weight="fill" />}>Doing</Chip>}
            {due && (
              <Chip tone={overdue ? "red" : today ? "lime" : null} icon={<Clock size={12} weight="bold" />}>
                {overdue ? `Late · ${when(task.due_date)}` : when(task.due_date)}
              </Chip>
            )}
            {task.category && task.category !== "GENERAL" && (
              <Chip icon={<Tag size={12} weight="bold" />}>{task.category.toLowerCase()}</Chip>
            )}
          </span>
        </button>
        {task.priority === "HIGH" && <Sticker tone="pink" tilt={4}>HIGH</Sticker>}
      </motion.div>
    </motion.li>
  );
});
