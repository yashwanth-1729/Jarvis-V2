"use client";

import * as React from "react";
import { motion, useMotionValue, useTransform, type PanInfo } from "framer-motion";
import { Check, Clock, Pause, Play, Tag } from "@phosphor-icons/react";

import { parseLocal } from "@/lib/utils";
import type { Task } from "@/types";
import { isOverdueTask } from "../lib/derive";
import { haptic } from "../lib/haptics";
import { dayDelta, when } from "../lib/time";
import { usePhone } from "../PhoneContext";
import { Chip, Sticker } from "../ui/Bits";

const THRESHOLD = 92;

/**
 * One task. Swipe right to finish it, left to start or pause it; tap the
 * circle to finish, tap the text to edit.
 */
export function TaskRow({ task, onEdit, index = 0 }: { task: Task; onEdit: (task: Task) => void; index?: number }) {
  const { finish, checked, app } = usePhone();
  const done = checked.has(task.id);
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
      layout="position"
      className="ph-task"
      data-done={done}
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0, transition: { type: "spring", stiffness: 420, damping: 30, delay: Math.min(index, 8) * 0.035 } }}
      exit={{ opacity: 0, height: 0, marginBottom: 0, scale: 0.96, transition: { duration: 0.28, ease: [0.4, 0, 0.2, 1] } }}
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
        <motion.button
          ref={checkRef}
          type="button"
          className="ph-check"
          data-status={done ? "COMPLETED" : task.status}
          aria-label={`Finish: ${task.title}`}
          whileTap={{ scale: 0.8 }}
          onClick={complete}
        >
          <motion.span
            className="ph-check-fill"
            initial={false}
            animate={done ? { scale: [0.4, 1.25, 1], opacity: 1 } : { scale: 0.4, opacity: 0 }}
            transition={{ duration: 0.38, ease: [0.34, 1.56, 0.64, 1] }}
          />
          <svg viewBox="0 0 24 24" className="ph-check-mark" aria-hidden="true">
            <motion.path
              d="M6 12.5l4 4 8-9"
              initial={false}
              animate={{ pathLength: done ? 1 : 0, opacity: done ? 1 : 0 }}
              transition={{ duration: 0.3, delay: done ? 0.08 : 0 }}
            />
          </svg>
        </motion.button>
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
}
