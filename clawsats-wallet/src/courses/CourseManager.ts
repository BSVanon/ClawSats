/**
 * CourseManager — BSV Cluster Courses Framework
 *
 * Static JSON courses, zero runtime AI cost. The MCP library gets distilled
 * ONCE into bite-size JSON files (by a separate process). Claws load them,
 * pass quizzes, and unlock teach capabilities.
 *
 * ECONOMICS:
 * - Human donates BSV → splits into course-funding packets
 * - Each packet pays a Claw to take a course (Claw gets sats + knowledge)
 * - Claw that passed a course can teach it to other Claws for pay
 * - Teaching Claw earns sats, learning Claw gains capability. Repeat.
 * - Metrics track spread: donors see impact
 *
 * DESIGN CONSTRAINTS (from user):
 * - No runtime AI/MCP cost — courses are static JSON
 * - Must not overshadow the general economy (A > B)
 * - Education is a means to liquidity, not the purpose
 * - Claws spread BSV education for selfish economic reasons
 */

import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { log, logWarn } from '../utils';

const TAG = 'courses';

// ── Course JSON Schema ──────────────────────────────────────────────
// This is the spec that another AI fills in from the MCP library.
// Each file in courses/ follows this format.

export interface CourseQuizQuestion {
  question: string;
  options: string[];        // 4 options, one correct
  correctHash: string;      // sha256(correctAnswer) — Claws can't cheat without reading
}

export interface Course {
  id: string;                // e.g. "bsv-101"
  title: string;             // e.g. "What is BSV?"
  level: number;             // 1 = beginner, 2 = intermediate, 3 = advanced
  prerequisites: string[];   // course IDs that must be completed first
  category: string;          // "fundamentals" | "protocol" | "development" | "economics"
  summary: string;           // 1-2 sentence TLDR
  content: string;           // The actual course material (markdown)
  quiz: CourseQuizQuestion[];
  passingScore: number;      // e.g. 3 out of 5 = 0.6
  teachPrice: number;        // sats to charge when teaching this course to another Claw
  version: string;           // semver for content updates
}

// ── Completion Record ───────────────────────────────────────────────

export interface CourseCompletion {
  courseId: string;
  courseVersion: string;
  completedAt: string;       // ISO timestamp
  score: number;             // 0.0 - 1.0
  learnedFrom?: string;      // identity key of the Claw that taught us (if peer-taught)
  donationTxid?: string;     // if funded by a human donation
}

// ── Spread Metrics ──────────────────────────────────────────────────

export interface CourseMetrics {
  courseId: string;
  totalCompletions: number;
  totalTaught: number;       // how many times this Claw taught this course
  propagationDepth: number;  // how many generations deep (donor → claw1 → claw2 → ...)
  uniqueLearners: string[];  // identity keys of Claws we taught
}

// ── Donation Record ─────────────────────────────────────────────────

export interface DonationRecord {
  donationId: string;
  donorIdentifier: string;   // human-readable label or identity key
  totalSats: number;
  coursesTargeted: string[]; // which courses to fund, or ['*'] for any
  clawsFunded: number;       // how many Claws got funded from this donation
  clawsTaught: number;       // how many Claws subsequently learned from funded Claws
  createdAt: string;
}

// ── CourseManager ───────────────────────────────────────────────────

export class CourseManager {
  private courses: Map<string, Course> = new Map();
  private completions: Map<string, CourseCompletion> = new Map(); // courseId → completion
  private metrics: Map<string, CourseMetrics> = new Map();
  private donations: DonationRecord[] = [];
  private dataDir: string;
  private coursesDir: string;

  constructor(dataDir: string, coursesDir?: string) {
    this.dataDir = dataDir;
    this.coursesDir = coursesDir || join(dataDir, '..', 'courses');
  }

  /**
   * Load all course JSON files from the courses directory.
   * Returns the number of courses loaded.
   */
  loadCourses(): number {
    if (!existsSync(this.coursesDir)) {
      log(TAG, `No courses directory at ${this.coursesDir}`);
      return 0;
    }

    const files = readdirSync(this.coursesDir).filter(f => f.endsWith('.json'));
    let loaded = 0;

    for (const file of files) {
      try {
        const raw = readFileSync(join(this.coursesDir, file), 'utf8');
        const course: Course = JSON.parse(raw);

        // Validate required fields
        if (!course.id || !course.title || !course.content || !course.quiz) {
          logWarn(TAG, `Skipping invalid course file: ${file}`);
          continue;
        }

        this.courses.set(course.id, course);
        loaded++;
      } catch (err) {
        logWarn(TAG, `Failed to load course ${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    log(TAG, `Loaded ${loaded} courses from ${this.coursesDir}`);
    return loaded;
  }

  /**
   * Load completion state from disk (persists across restarts).
   */
  loadState(): void {
    const statePath = join(this.dataDir, 'course-state.json');
    if (!existsSync(statePath)) return;

    try {
      const raw = readFileSync(statePath, 'utf8');
      const state = JSON.parse(raw);
      if (state.completions) {
        for (const [id, comp] of Object.entries(state.completions)) {
          this.completions.set(id, comp as CourseCompletion);
        }
      }
      if (state.metrics) {
        for (const [id, met] of Object.entries(state.metrics)) {
          this.metrics.set(id, met as CourseMetrics);
        }
      }
      if (state.donations) {
        this.donations = state.donations;
      }
      log(TAG, `Loaded state: ${this.completions.size} completions, ${this.donations.length} donations`);
    } catch {
      logWarn(TAG, 'Failed to load course state');
    }
  }

  /**
   * Save completion state to disk.
   */
  saveState(): void {
    if (!existsSync(this.dataDir)) {
      mkdirSync(this.dataDir, { recursive: true });
    }
    const statePath = join(this.dataDir, 'course-state.json');
    const state = {
      completions: Object.fromEntries(this.completions),
      metrics: Object.fromEntries(this.metrics),
      donations: this.donations
    };
    writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
  }

  /**
   * List available courses with completion status.
   */
  listCourses(): {
    id: string;
    title: string;
    level: number;
    category: string;
    summary: string;
    completed: boolean;
    prerequisitesMet: boolean;
    teachPrice: number;
  }[] {
    return Array.from(this.courses.values()).map(c => ({
      id: c.id,
      title: c.title,
      level: c.level,
      category: c.category,
      summary: c.summary,
      completed: this.completions.has(c.id),
      prerequisitesMet: this.prerequisitesMet(c.id),
      teachPrice: c.teachPrice
    }));
  }

  /**
   * Get a course by ID.
   */
  getCourse(courseId: string): Course | undefined {
    return this.courses.get(courseId);
  }

  /**
   * Check if prerequisites are met for a course.
   */
  prerequisitesMet(courseId: string): boolean {
    const course = this.courses.get(courseId);
    if (!course) return false;
    return course.prerequisites.every(prereq => this.completions.has(prereq));
  }

  /**
   * Check if a course has been completed.
   */
  isCompleted(courseId: string): boolean {
    return this.completions.has(courseId);
  }

  /**
   * Take a quiz for a course. Returns score and whether it was passed.
   * Answers are verified against hashed correct answers — no cheating.
   */
  takeQuiz(courseId: string, answers: string[]): {
    passed: boolean;
    score: number;
    correct: number;
    total: number;
  } {
    const course = this.courses.get(courseId);
    if (!course) throw new Error(`Unknown course: ${courseId}`);
    if (!this.prerequisitesMet(courseId)) {
      throw new Error(`Prerequisites not met: ${course.prerequisites.join(', ')}`);
    }

    const quiz = course.quiz;
    if (answers.length !== quiz.length) {
      throw new Error(`Expected ${quiz.length} answers, got ${answers.length}`);
    }

    let correct = 0;
    for (let i = 0; i < quiz.length; i++) {
      const answerHash = createHash('sha256').update(answers[i]).digest('hex');
      if (answerHash === quiz[i].correctHash) {
        correct++;
      }
    }

    const score = correct / quiz.length;
    const passed = score >= course.passingScore;

    if (passed && !this.completions.has(courseId)) {
      this.completions.set(courseId, {
        courseId,
        courseVersion: course.version,
        completedAt: new Date().toISOString(),
        score
      });
      this.saveState();
      log(TAG, `Course ${courseId} completed with score ${(score * 100).toFixed(0)}%`);
    }

    return { passed, score, correct, total: quiz.length };
  }

  /**
   * Get the course content for teaching to another Claw.
   * Only works if this Claw has completed the course.
   * Returns the full course material that the learner needs.
   */
  getTeachingMaterial(courseId: string): {
    course: Course;
    teacherCompletion: CourseCompletion;
  } | null {
    if (!this.completions.has(courseId)) return null;
    const course = this.courses.get(courseId);
    if (!course) return null;
    return {
      course,
      teacherCompletion: this.completions.get(courseId)!
    };
  }

  /**
   * Record that we taught a course to another Claw.
   */
  recordTeaching(courseId: string, learnerIdentityKey: string): void {
    let met = this.metrics.get(courseId);
    if (!met) {
      met = {
        courseId,
        totalCompletions: this.completions.has(courseId) ? 1 : 0,
        totalTaught: 0,
        propagationDepth: 0,
        uniqueLearners: []
      };
      this.metrics.set(courseId, met);
    }
    met.totalTaught++;
    if (!met.uniqueLearners.includes(learnerIdentityKey)) {
      met.uniqueLearners.push(learnerIdentityKey);
    }
    this.saveState();
  }

  /**
   * Record a human donation.
   */
  recordDonation(donation: DonationRecord): void {
    this.donations.push(donation);
    this.saveState();
  }

  /**
   * Get spread metrics for donors — how far has education propagated?
   */
  getSpreadMetrics(): {
    totalCoursesAvailable: number;
    totalCoursesCompleted: number;
    totalTimesTeught: number;
    totalUniqueLearners: number;
    totalDonations: number;
    totalDonatedSats: number;
    courseBreakdown: {
      courseId: string;
      title: string;
      completions: number;
      timesTeught: number;
      uniqueLearners: number;
    }[];
  } {
    const allLearners = new Set<string>();
    let totalTaught = 0;

    const courseBreakdown = Array.from(this.courses.values()).map(c => {
      const met = this.metrics.get(c.id);
      if (met) {
        totalTaught += met.totalTaught;
        met.uniqueLearners.forEach(l => allLearners.add(l));
      }
      return {
        courseId: c.id,
        title: c.title,
        completions: met?.totalCompletions || (this.completions.has(c.id) ? 1 : 0),
        timesTeught: met?.totalTaught || 0,
        uniqueLearners: met?.uniqueLearners.length || 0
      };
    });

    return {
      totalCoursesAvailable: this.courses.size,
      totalCoursesCompleted: this.completions.size,
      totalTimesTeught: totalTaught,
      totalUniqueLearners: allLearners.size,
      totalDonations: this.donations.length,
      totalDonatedSats: this.donations.reduce((sum, d) => sum + d.totalSats, 0),
      courseBreakdown
    };
  }

  /**
   * Get list of course IDs this Claw has completed (can teach).
   */
  getCompletedCourseIds(): string[] {
    return Array.from(this.completions.keys());
  }

  /**
   * Get the number of loaded courses.
   */
  get courseCount(): number {
    return this.courses.size;
  }
}
