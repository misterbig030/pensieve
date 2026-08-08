import { AdjustDraftEditor } from "./AdjustDraftEditor";

export default async function AdjustTrackPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <div className="mx-auto max-w-2xl space-y-4 p-6">
      <h1 className="text-xl font-semibold">调整学习计划</h1>
      <p className="text-sm text-muted-foreground">
        只会替换还没学完的部分，已经打卡完成的天数不会被改动。
      </p>
      <AdjustDraftEditor trackId={id} />
    </div>
  );
}
