import { useState } from 'react';
import { Copy, Check } from 'lucide-react';
import toast from 'react-hot-toast';

interface QrCodeDisplayProps {
  pixCode: string | null;
  pixQrPngBase64: string | null;
  pixImageUrl?: string | null;
  pixExpiresAt?: string | null;
}

export default function QrCodeDisplay({ pixCode, pixQrPngBase64, pixImageUrl, pixExpiresAt }: QrCodeDisplayProps) {
  const [copied, setCopied] = useState(false);

  const imageSrc = pixQrPngBase64
    ? `data:image/png;base64,${pixQrPngBase64}`
    : pixImageUrl ?? undefined;

  if (!pixCode && !imageSrc) {
    return <p className="text-center text-app-secondary">暂无 Pix 付款码</p>;
  }

  const handleCopy = async () => {
    if (!pixCode) return;
    try {
      await navigator.clipboard.writeText(pixCode);
      setCopied(true);
      toast.success('Pix 付款码已复制');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('复制失败，请手动复制');
    }
  };

  return (
    <div className="flex flex-col items-stretch gap-4">
      {imageSrc && (
        <div className="pix-qr-shell">
          <img src={imageSrc} alt="Pix 二维码" className="pix-qr-image" />
        </div>
      )}

      {pixCode && (
        <div>
          <label className="checkout-label">Pix 付款码</label>
          <div className="pix-code-row">
            <input
              type="text"
              readOnly
              value={pixCode}
              className="pix-code-input"
              onClick={(e) => (e.target as HTMLInputElement).select()}
            />
            <button
              type="button"
              onClick={handleCopy}
              className="checkout-icon-button"
              aria-label="复制 Pix 付款码"
            >
              {copied ? <Check size={16} /> : <Copy size={16} />}
            </button>
          </div>
        </div>
      )}

      {pixExpiresAt && (
        <div className="flex justify-between border-t border-app-border pt-4 text-sm">
          <span className="text-app-secondary">过期时间</span>
          <strong className="text-app-primary">
            {new Date(pixExpiresAt).toLocaleString('zh-CN')}
          </strong>
        </div>
      )}
    </div>
  );
}
