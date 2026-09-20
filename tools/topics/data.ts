import { TopicMapSchema, type TopicMap } from "../../src/domain/topics.js";
import { readData } from "../review/data.js";

export async function readTopicMap(workspace = process.cwd()): Promise<TopicMap> {
  return readData(".data/topics/topic-map.json", TopicMapSchema, workspace);
}
