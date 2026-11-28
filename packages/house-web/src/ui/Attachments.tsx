import { Icon } from "@astryxdesign/core/Icon";
import { useEffect, useState } from "react";

import { REPLY_IMAGES_MAX } from "@penelope/contract";

import type { Attachment } from "../model/attachments.ts";
import { words } from "./words.ts";

const problems = { size: words.imageSize, name: words.imageName, format: words.imageFormat, read: words.imageReadFailed };

export function Attachments({ attachments, onRemove }: { attachments: readonly Attachment[]; onRemove: (id: number) => void }) {
  return (
    <ul className="speak-attachments" role="list">
      {attachments.map((image, index) => (
        <li key={image.id} className="speak-attachment">
          {index < REPLY_IMAGES_MAX && image.kind === "ready" ? <Preview file={image.file} mime={image.mime} /> : null}
          <div className="speak-attachment-name">
            <span translate="no">{image.file.name}</span>
            <span className="speak-attachment-status" role="status">
              {index >= REPLY_IMAGES_MAX ? words.imageCount : image.kind === "checking" ? words.imageReading : image.kind === "invalid" ? problems[image.reason] : null}
            </span>
          </div>
          <button type="button" aria-label={words.removeImage(image.file.name)} onClick={() => onRemove(image.id)}>
            <Icon icon="close" size="xsm" color="inherit" />
          </button>
        </li>
      ))}
    </ul>
  );
}

function Preview({ file, mime }: { file: File; mime: string }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    const created = URL.createObjectURL(file.slice(0, file.size, mime));
    setUrl(created);
    return () => URL.revokeObjectURL(created);
  }, [file, mime]);
  return url ? <img src={url} alt="" width={56} height={56} /> : null;
}
