import { Page } from '../components/Page.jsx';
import { Base64Tool, JsonFormatter, RegexTester, TimestampTool } from '../components/tools/localTools.jsx';
import { CronPreview, HashGenerator, HttpClient, JwtDecoder, UuidGenerator } from '../components/tools/serverTools.jsx';

export default function Tools() {
  return (
    <Page title="Dev Tools" subtitle="The utilities you would otherwise paste into a random website.">
      <HttpClient />
      <div className="grid two-col">
        <JsonFormatter />
        <JwtDecoder />
        <Base64Tool />
        <HashGenerator />
        <RegexTester />
        <CronPreview />
        <TimestampTool />
        <UuidGenerator />
      </div>
    </Page>
  );
}
