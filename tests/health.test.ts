import { GET } from "@/app/api/health/route";
test("health responde ok", async () => {
  const res = await GET();
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});
