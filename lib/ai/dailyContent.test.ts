import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("ai", () => ({ generateObject: vi.fn() }));
import { generateObject } from "ai";
import type { ModelCall } from "./logged";
import { buildDailyContentPrompt, enforceCitations, generateDailyContent, type LessonPractice } from "./dailyContent";

const mockedGenerateObject = vi.mocked(generateObject);

describe("buildDailyContentPrompt", () => {
  it("includes the day's title and summary", () => {
    const prompt = buildDailyContentPrompt({
      title: "Load balancing",
      summary: "L4 vs L7, algorithms",
      materials: [],
    });
    expect(prompt).toContain("Load balancing");
    expect(prompt).toContain("L4 vs L7, algorithms");
  });

  it("separates youtube sources from link sources and instructs embedding, not transcript extraction", () => {
    const prompt = buildDailyContentPrompt({
      title: "Caching",
      summary: "Cache strategies",
      materials: [
        { url: "https://youtube.com/watch?v=abc", type: "youtube", title: "Caching talk" },
        { url: "https://example.com/article", type: "link", title: "Caching article" },
      ],
    });
    expect(prompt).toContain("https://youtube.com/watch?v=abc");
    expect(prompt).toMatch(/embed|link card/i);
    expect(prompt).not.toMatch(/transcript/i);
  });

  it("mentions file/note materials as context without treating them as citable", () => {
    const prompt = buildDailyContentPrompt({
      title: "Caching",
      summary: "Cache strategies",
      materials: [{ url: "notes.pdf", type: "file", title: "My notes" }],
    });
    expect(prompt).toContain("My notes");
    expect(prompt).toMatch(/cannot access their contents/i);
  });

  it("lists the unit's Read table with tier, minutes and note, and limits citations to it", () => {
    const prompt = buildDailyContentPrompt({
      title: "Evals",
      summary: "How to evaluate LLM apps",
      unit: "week",
      spanDays: 7,
      materials: [{ url: "https://example.com/ai-eng", type: "link", title: "AI Engineering", tier: "must", minutes: 90, note: "Ch. 4 §2" }],
    });
    expect(prompt).toContain("- AI Engineering (https://example.com/ai-eng) — must, 90 min, Ch. 4 §2");
    expect(prompt).toMatch(/list only materials from this unit's list/);
    expect(prompt).not.toMatch(/search the web/i);
  });

  it("names the chapter, its sections from the note or the list, and reviews", () => {
    const base = { url: "https://example.com/aie", type: "link" as const, title: "AI Engineering", tier: "must" as const, minutes: 35 };
    const ch2 = { n: 2, title: "Understanding Foundation Models", sections: ["Training Data", "Modeling", "Post-Training", "Sampling"] };
    const prompt = buildDailyContentPrompt({
      title: "D",
      summary: "s",
      materials: [
        { ...base, note: "Post-Training; Sampling", chapter: ch2 },
        { ...base, note: null, chapter: ch2, tier: "should", minutes: 140 },
        { ...base, note: null, chapter: { n: 1, title: "Introduction", sections: [] }, activity: "review", tier: "should", minutes: 20 },
        { ...base, note: null, chapter: { n: null, title: "Untitled part", sections: [] } },
      ],
    });
    expect(prompt).toContain('- AI Engineering (https://example.com/aie) — ch. 2 "Understanding Foundation Models" · sections: Post-Training; Sampling — must, 35 min');
    expect(prompt).toContain('- AI Engineering (https://example.com/aie) — ch. 2 "Understanding Foundation Models" · sections: Training Data; Modeling; Post-Training; Sampling — should, 140 min');
    expect(prompt).toContain('- AI Engineering (https://example.com/aie) — review of ch. 1 "Introduction" — should, 20 min');
    expect(prompt).toContain('- AI Engineering (https://example.com/aie) — "Untitled part" — must, 35 min');
    expect(prompt).toContain("Rows marked review revisit material the learner read earlier: recap and connect it to today, do not teach it afresh.");
    expect(buildDailyContentPrompt({ title: "D", summary: "s", materials: [{ ...base, note: "Ch. 4 §2" }] })).not.toContain("Rows marked review");
  });

  describe("practice", () => {
    const input = {
      title: "Load balancing",
      summary: "L4 vs L7, algorithms",
      materials: [{ url: "https://example.com/ai-eng", type: "link" as const, title: "AI Engineering", tier: "must" as const, minutes: 90, note: "Ch. 4 §2" }],
    };
    // The prompt of the input above as it was before practice existed.
    const BEFORE_PRACTICE = [
      "Write today's lesson for a self-study curriculum.",
      "Day title: Load balancing",
      "Day summary: L4 vs L7, algorithms",
      "This unit's reading list. Guide the learner through it in order of tier (must before should), and point to the part named in each note:",
      "- AI Engineering (https://example.com/ai-eng) — must, 90 min, Ch. 4 §2",
      `Write the lesson body as markdown in the "contentMarkdown" field. In "citations", list only materials from this unit's list above that the lesson draws on, with their exact URL. Cite nothing else.`,
    ].join("\n");
    const problems: LessonPractice = {
      format: "problem-set",
      label: "Problems",
      task: "Do problems 1-10",
      done: "all ten solved without the answers",
      minutes: 60,
      source: { title: "Problem list", url: "https://example.com/problems" },
      generated: false,
    };
    const recall: LessonPractice = {
      format: "recall",
      label: "Recall",
      task: "Answer questions on the reading",
      done: "every answer matches the reading",
      minutes: 20,
      source: { title: "AI Engineering", url: "https://example.com/ai-eng" },
      generated: true,
    };
    const lab: LessonPractice = { format: "lab", label: "Lab", task: "Set up a proxy", done: "requests balance across two servers", minutes: 45, source: null, generated: true };

    it("gives the same prompt as before for a unit without practice", () => {
      expect(buildDailyContentPrompt(input)).toBe(BEFORE_PRACTICE);
      expect(buildDailyContentPrompt({ ...input, practice: undefined })).toBe(BEFORE_PRACTICE);
      expect(buildDailyContentPrompt({ ...input, practice: [] })).toBe(BEFORE_PRACTICE);
    });

    it("lists each task with its minutes and done line, and a source's link", () => {
      const prompt = buildDailyContentPrompt({ ...input, practice: [problems] });
      expect(prompt).toContain("- Problems: Do problems 1-10 (60 min) — done when: all ten solved without the answers — source: Problem list (https://example.com/problems)");
      expect(prompt).toMatch(/end the lesson with a section on how to do and check each task/i);
      expect(prompt).toContain(`Cite nothing else.`);
    });

    it("marks a task without a source as generated", () => {
      const prompt = buildDailyContentPrompt({ ...input, practice: [lab] });
      expect(prompt).toContain("- Lab: Set up a proxy (45 min) — done when: requests balance across two servers — generated");
    });

    it("asks for a generated recall task's answers in an answers fence, as markdown, drawn from the reading", () => {
      const prompt = buildDailyContentPrompt({ ...input, practice: [recall] });
      expect(prompt).toContain("- Recall: Answer questions on the reading (20 min) — done when: every answer matches the reading — generated from the reading: AI Engineering (https://example.com/ai-eng)");
      expect(prompt).toContain('then their answers in a fenced code block with the info string "answers" (```answers), written as markdown inside the fence');
      expect(prompt).not.toContain("<details>");
      expect(prompt).toMatch(/only from this unit's reading/);
    });

    it("asks for the answers fence only for generated recall, and for other generated tasks gives how-to guidance only", () => {
      expect(buildDailyContentPrompt({ ...input, practice: [problems, lab] })).not.toContain("```answers");
      expect(buildDailyContentPrompt({ ...input, practice: [problems, lab] })).toMatch(/generated tasks of any other format[^\n]*guidance only/i);
      expect(buildDailyContentPrompt({ ...input, practice: [problems] })).not.toMatch(/generated tasks/i);
      expect(buildDailyContentPrompt({ ...input, practice: [{ ...recall, generated: false }] })).not.toContain("```answers");
    });

    describe("steps", () => {
      const read = { ...input.materials[0]!, step: { token: "T1", id: "read:aie#3" } };
      const steps = { ...input, materials: [read], practice: [{ ...problems, step: { token: "T2", id: "practice:problem-set#nc#4" } }] };
      const STEPS_PARAGRAPH = `Each task above has a label in square brackets, like [T1]. Write the lesson as a walk-through of these tasks in this order. Each time the learner should go and do part of a task, write a step: a fenced code block with the info string "step" (\`\`\`step), at the top level of the lesson, never inside a list, whose first line names the one task by its label without brackets, as in "task: T1", whose second line is your estimate for that step, as in "minutes: 25", and whose other lines say in one or two sentences of markdown exactly what to do. A task may have several steps, such as the first half of a chapter and then the second. Write your explanation between the steps as ordinary markdown.`;

      it("labels each task with its token in steps mode", () => {
        const prompt = buildDailyContentPrompt(steps);
        expect(prompt).toContain("- [T1] AI Engineering (https://example.com/ai-eng) — must, 90 min, Ch. 4 §2");
        expect(prompt).toContain("- [T2] Problems: Do problems 1-10 (60 min)");
      });

      it("asks for step blocks naming one task each, in order", () => {
        expect(buildDailyContentPrompt(steps)).toContain(STEPS_PARAGRAPH);
        expect(buildDailyContentPrompt({ ...input, materials: [read] })).toContain(STEPS_PARAGRAPH);
      });

      it("asks for each practice task's how-to around its steps in steps mode", () => {
        const prompt = buildDailyContentPrompt(steps);
        expect(prompt).toContain(
          `This unit's practice. Give each task at least one step, and around its steps explain how to set it up, how to work through it, and how the learner knows it is done, by its "done when" line. Link a task's source where it helps, but cite none of these sources in "citations":`,
        );
        expect(prompt).not.toMatch(/end the lesson with a section/i);
      });

      it("gives the same prompt as before when no task has a token", () => {
        expect(buildDailyContentPrompt(input)).not.toContain("[T1]");
        expect(buildDailyContentPrompt({ ...input, practice: [problems] })).not.toContain(STEPS_PARAGRAPH);
      });
    });
  });

  it("asks for no citations when nothing on the list is citable", () => {
    const prompt = buildDailyContentPrompt({ title: "A", summary: "B", materials: [] });
    expect(prompt).toMatch(/leave "citations" empty/);
  });
});

describe("enforceCitations", () => {
  const materials = [
    { url: "https://www.example.com/guide/", type: "link" as const, title: "The guide" },
    { url: "https://youtu.be/abc", type: "youtube" as const, title: "The talk" },
    { url: "My notes", type: "note" as const, title: "My notes" },
  ];
  it("keeps citations of assigned materials, under their own titles, and drops the rest", () => {
    const result = enforceCitations(
      [
        { title: "guide", url: "https://example.com/guide#part-2" },
        { title: "Something else", url: "https://elsewhere.example.com/" },
        { title: "Talk", url: "https://youtu.be/abc" },
        { title: "dup", url: "https://example.com/guide" },
      ],
      materials,
    );
    expect(result.citations).toEqual([
      { title: "The guide", url: "https://www.example.com/guide/" },
      { title: "The talk", url: "https://youtu.be/abc" },
    ]);
    expect(result.dropped).toBe(1);
  });

  it("drops a practice source's URL, unless the unit's materials list it too", () => {
    const cited = [{ title: "Problem list", url: "https://example.com/problems" }];
    expect(enforceCitations(cited, materials)).toEqual({ citations: [], dropped: 1 });
    const withReading = [...materials, { url: "https://example.com/problems", type: "link" as const, title: "Problem list" }];
    expect(enforceCitations(cited, withReading).citations).toEqual(cited);
  });
});

describe("generateDailyContent", () => {
  beforeEach(() => {
    mockedGenerateObject.mockReset();
  });

  it("generates on the content model it is given and records who paid", async () => {
    mockedGenerateObject.mockResolvedValue({
      object: { contentMarkdown: "Read ch. 1.", citations: [] },
      usage: { inputTokens: 10, outputTokens: 5, inputTokenDetails: {}, outputTokenDetails: {}, totalTokens: 15 },
      finishReason: "stop",
    } as unknown as Awaited<ReturnType<typeof generateObject>>);
    const direct = { modelId: "claude-sonnet-5", provider: "anthropic.messages" };
    const calls: ModelCall[] = [];
    await generateDailyContent({
      title: "Day 1",
      summary: "s",
      unit: "day",
      spanDays: 1,
      materials: [],
      model: { model: direct as never, id: "anthropic/claude-sonnet-5", keyOwner: "user" },
      log: { onCall: (c) => void calls.push(c) },
    });
    expect(mockedGenerateObject.mock.calls[0][0].model).toBe(direct);
    expect(calls[0]).toMatchObject({ model: "anthropic/claude-sonnet-5", keyOwner: "user" });
    expect(calls[0].label).toBe("Lesson · Day 1");
  });

  it("stores step blocks with task ids, not tokens", async () => {
    mockedGenerateObject.mockResolvedValue({
      object: { contentMarkdown: "Intro.\n\n```step\ntask: T1\nminutes: 20\nRead it.\n```\n\n```step\ntask: T7\nGo.\n```", citations: [] },
      usage: { inputTokens: 10, outputTokens: 5, inputTokenDetails: {}, outputTokenDetails: {}, totalTokens: 15 },
      finishReason: "stop",
    } as unknown as Awaited<ReturnType<typeof generateObject>>);
    const { content } = await generateDailyContent({
      title: "Day 1",
      summary: "s",
      materials: [{ title: "AI Engineering", url: "https://example.com/ai-eng", type: "link", step: { token: "T1", id: "read:aie#3" } }],
    });
    expect(content.contentMarkdown).toBe("Intro.\n\n```step\ntask: read:aie#3\nminutes: 20\nRead it.\n```\n\n```step\ntask:\nGo.\n```");
  });
});
