import { CourseManager, Course } from '../../src/courses/CourseManager';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';

const TEST_DIR = join(__dirname, '..', 'tmp-course-test');
const COURSES_DIR = join(TEST_DIR, 'courses');
const DATA_DIR = join(TEST_DIR, 'data');

// Helper: create a valid course JSON
function makeTestCourse(overrides: Partial<Course> = {}): Course {
  const correctAnswers = ['Answer B', 'Answer C', 'Answer A'];
  return {
    id: 'test-101',
    title: 'Test Course',
    level: 1,
    prerequisites: [],
    category: 'fundamentals',
    summary: 'A test course for unit testing.',
    content: '# Test Course\n\nThis is test content.',
    quiz: correctAnswers.map((ans, i) => ({
      question: `Question ${i + 1}?`,
      options: ['Answer A', 'Answer B', 'Answer C', 'Answer D'],
      correctHash: createHash('sha256').update(ans).digest('hex')
    })),
    passingScore: 0.6, // 2/3 correct to pass
    teachPrice: 25,
    version: '1.0.0',
    ...overrides
  };
}

function setupTestDirs(): void {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(COURSES_DIR, { recursive: true });
  mkdirSync(DATA_DIR, { recursive: true });
}

function cleanupTestDirs(): void {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
}

describe('CourseManager', () => {
  beforeEach(() => setupTestDirs());
  afterEach(() => cleanupTestDirs());

  test('loads courses from directory', () => {
    const course = makeTestCourse();
    writeFileSync(join(COURSES_DIR, 'test-101.json'), JSON.stringify(course));

    const mgr = new CourseManager(DATA_DIR, COURSES_DIR);
    const loaded = mgr.loadCourses();

    expect(loaded).toBe(1);
    expect(mgr.courseCount).toBe(1);
    expect(mgr.getCourse('test-101')).toBeDefined();
    expect(mgr.getCourse('test-101')?.title).toBe('Test Course');
  });

  test('skips invalid course files', () => {
    writeFileSync(join(COURSES_DIR, 'bad.json'), JSON.stringify({ foo: 'bar' }));
    writeFileSync(join(COURSES_DIR, 'good.json'), JSON.stringify(makeTestCourse()));

    const mgr = new CourseManager(DATA_DIR, COURSES_DIR);
    const loaded = mgr.loadCourses();

    expect(loaded).toBe(1);
  });

  test('returns 0 if courses directory does not exist', () => {
    const mgr = new CourseManager(DATA_DIR, '/nonexistent/path');
    expect(mgr.loadCourses()).toBe(0);
  });

  test('listCourses shows completion status', () => {
    writeFileSync(join(COURSES_DIR, 'test-101.json'), JSON.stringify(makeTestCourse()));

    const mgr = new CourseManager(DATA_DIR, COURSES_DIR);
    mgr.loadCourses();

    const list = mgr.listCourses();
    expect(list).toHaveLength(1);
    expect(list[0].completed).toBe(false);
    expect(list[0].prerequisitesMet).toBe(true); // no prereqs
  });

  test('takeQuiz passes with correct answers', () => {
    writeFileSync(join(COURSES_DIR, 'test-101.json'), JSON.stringify(makeTestCourse()));

    const mgr = new CourseManager(DATA_DIR, COURSES_DIR);
    mgr.loadCourses();

    // All 3 correct
    const result = mgr.takeQuiz('test-101', ['Answer B', 'Answer C', 'Answer A']);
    expect(result.passed).toBe(true);
    expect(result.score).toBe(1.0);
    expect(result.correct).toBe(3);
    expect(result.total).toBe(3);
    expect(mgr.isCompleted('test-101')).toBe(true);
  });

  test('takeQuiz passes with minimum passing score', () => {
    writeFileSync(join(COURSES_DIR, 'test-101.json'), JSON.stringify(makeTestCourse()));

    const mgr = new CourseManager(DATA_DIR, COURSES_DIR);
    mgr.loadCourses();

    // 2/3 correct (0.67 >= 0.6 passing)
    const result = mgr.takeQuiz('test-101', ['Answer B', 'Answer C', 'WRONG']);
    expect(result.passed).toBe(true);
    expect(result.correct).toBe(2);
  });

  test('takeQuiz fails with too few correct', () => {
    writeFileSync(join(COURSES_DIR, 'test-101.json'), JSON.stringify(makeTestCourse()));

    const mgr = new CourseManager(DATA_DIR, COURSES_DIR);
    mgr.loadCourses();

    // 1/3 correct (0.33 < 0.6 passing)
    const result = mgr.takeQuiz('test-101', ['Answer B', 'WRONG', 'WRONG']);
    expect(result.passed).toBe(false);
    expect(result.correct).toBe(1);
    expect(mgr.isCompleted('test-101')).toBe(false);
  });

  test('takeQuiz rejects wrong answer count', () => {
    writeFileSync(join(COURSES_DIR, 'test-101.json'), JSON.stringify(makeTestCourse()));

    const mgr = new CourseManager(DATA_DIR, COURSES_DIR);
    mgr.loadCourses();

    expect(() => mgr.takeQuiz('test-101', ['A'])).toThrow('Expected 3 answers');
  });

  test('takeQuiz rejects unknown course', () => {
    const mgr = new CourseManager(DATA_DIR, COURSES_DIR);
    mgr.loadCourses();

    expect(() => mgr.takeQuiz('nonexistent', [])).toThrow('Unknown course');
  });

  test('prerequisites enforcement', () => {
    const course1 = makeTestCourse({ id: 'prereq-101' });
    const course2 = makeTestCourse({ id: 'advanced-201', prerequisites: ['prereq-101'] });
    writeFileSync(join(COURSES_DIR, 'prereq.json'), JSON.stringify(course1));
    writeFileSync(join(COURSES_DIR, 'advanced.json'), JSON.stringify(course2));

    const mgr = new CourseManager(DATA_DIR, COURSES_DIR);
    mgr.loadCourses();

    // Can't take advanced without prereq
    expect(mgr.prerequisitesMet('advanced-201')).toBe(false);
    expect(() => mgr.takeQuiz('advanced-201', ['Answer B', 'Answer C', 'Answer A']))
      .toThrow('Prerequisites not met');

    // Complete prereq
    mgr.takeQuiz('prereq-101', ['Answer B', 'Answer C', 'Answer A']);
    expect(mgr.prerequisitesMet('advanced-201')).toBe(true);

    // Now advanced works
    const result = mgr.takeQuiz('advanced-201', ['Answer B', 'Answer C', 'Answer A']);
    expect(result.passed).toBe(true);
  });

  test('getTeachingMaterial returns null if not completed', () => {
    writeFileSync(join(COURSES_DIR, 'test-101.json'), JSON.stringify(makeTestCourse()));

    const mgr = new CourseManager(DATA_DIR, COURSES_DIR);
    mgr.loadCourses();

    expect(mgr.getTeachingMaterial('test-101')).toBeNull();
  });

  test('getTeachingMaterial returns course after completion', () => {
    writeFileSync(join(COURSES_DIR, 'test-101.json'), JSON.stringify(makeTestCourse()));

    const mgr = new CourseManager(DATA_DIR, COURSES_DIR);
    mgr.loadCourses();
    mgr.takeQuiz('test-101', ['Answer B', 'Answer C', 'Answer A']);

    const material = mgr.getTeachingMaterial('test-101');
    expect(material).not.toBeNull();
    expect(material!.course.id).toBe('test-101');
    expect(material!.teacherCompletion.score).toBe(1.0);
  });

  test('recordTeaching tracks metrics', () => {
    writeFileSync(join(COURSES_DIR, 'test-101.json'), JSON.stringify(makeTestCourse()));

    const mgr = new CourseManager(DATA_DIR, COURSES_DIR);
    mgr.loadCourses();
    mgr.takeQuiz('test-101', ['Answer B', 'Answer C', 'Answer A']);

    mgr.recordTeaching('test-101', 'claw-abc');
    mgr.recordTeaching('test-101', 'claw-def');
    mgr.recordTeaching('test-101', 'claw-abc'); // duplicate learner

    const metrics = mgr.getSpreadMetrics();
    expect(metrics.totalTimesTeught).toBe(3);
    expect(metrics.totalUniqueLearners).toBe(2);
  });

  test('recordDonation tracks donations', () => {
    const mgr = new CourseManager(DATA_DIR, COURSES_DIR);

    mgr.recordDonation({
      donationId: 'don-1',
      donorIdentifier: 'test-human',
      totalSats: 10000,
      coursesTargeted: ['*'],
      clawsFunded: 0,
      clawsTaught: 0,
      createdAt: new Date().toISOString()
    });

    const metrics = mgr.getSpreadMetrics();
    expect(metrics.totalDonations).toBe(1);
    expect(metrics.totalDonatedSats).toBe(10000);
  });

  test('state persists across restarts', () => {
    writeFileSync(join(COURSES_DIR, 'test-101.json'), JSON.stringify(makeTestCourse()));

    // First instance: complete course
    const mgr1 = new CourseManager(DATA_DIR, COURSES_DIR);
    mgr1.loadCourses();
    mgr1.takeQuiz('test-101', ['Answer B', 'Answer C', 'Answer A']);
    mgr1.recordTeaching('test-101', 'claw-xyz');

    // Second instance: load state
    const mgr2 = new CourseManager(DATA_DIR, COURSES_DIR);
    mgr2.loadCourses();
    mgr2.loadState();

    expect(mgr2.isCompleted('test-101')).toBe(true);
    expect(mgr2.getCompletedCourseIds()).toContain('test-101');
    expect(mgr2.getTeachingMaterial('test-101')).not.toBeNull();
  });

  test('getCompletedCourseIds returns only completed', () => {
    const c1 = makeTestCourse({ id: 'course-a' });
    const c2 = makeTestCourse({ id: 'course-b' });
    writeFileSync(join(COURSES_DIR, 'a.json'), JSON.stringify(c1));
    writeFileSync(join(COURSES_DIR, 'b.json'), JSON.stringify(c2));

    const mgr = new CourseManager(DATA_DIR, COURSES_DIR);
    mgr.loadCourses();

    expect(mgr.getCompletedCourseIds()).toHaveLength(0);

    mgr.takeQuiz('course-a', ['Answer B', 'Answer C', 'Answer A']);
    expect(mgr.getCompletedCourseIds()).toEqual(['course-a']);
  });
});
