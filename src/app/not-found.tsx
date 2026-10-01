import { ErrorPanel } from "@/components/public/error-panel";

export default function NotFound() {
  return <ErrorPanel title="ページが見つかりません" message="URLが間違っているか、ページが移動した可能性があります。" />;
}
