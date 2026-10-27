import { useState } from 'react';
import { Upload, X } from 'lucide-react';
import { MAX_SIGNATURE_LOGO_BYTES, renderMailboxSignature } from '../domain/mail-signature.mjs';
import type { MailSignatureDesign } from '../domain/mail-signature.mjs';

export const defaultSignatureDesign = (companyName = '', website = ''): MailSignatureDesign => ({
  closing: 'Best regards,',
  companyName,
  address: '',
  website,
  logo: null,
  logoWidth: 160,
});

export function MailSignatureFields({
  email,
  displayName,
  signature,
  design,
  defaultCompany,
  defaultWebsite,
  disabled,
  onChange,
  onLegacyChange,
  onUploadingChange,
}: {
  email: string;
  displayName: string;
  signature: string;
  design: MailSignatureDesign | null;
  defaultCompany: string;
  defaultWebsite: string;
  disabled: boolean;
  onChange: (value: MailSignatureDesign) => void;
  onLegacyChange: (value: string) => void;
  onUploadingChange: (value: boolean) => void;
}) {
  const [logoError, setLogoError] = useState('');
  const [loadingLogo, setLoadingLogo] = useState(false);
  const preview = renderMailboxSignature({
    email,
    displayName,
    signature,
    signatureDesign: design,
  });
  async function upload(file: File) {
    if (!design) return;
    setLogoError('');
    if (!['image/png', 'image/jpeg'].includes(file.type) || file.size > MAX_SIGNATURE_LOGO_BYTES) {
      setLogoError('请选择不超过 256 KB 的 PNG 或 JPG 图片。');
      return;
    }
    setLoadingLogo(true);
    onUploadingChange(true);
    try {
      const source = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('图片读取失败，请重新选择。'));
        reader.readAsDataURL(file);
      });
      await new Promise<void>((resolve, reject) => {
        const image = new Image();
        image.onload = () =>
          image.naturalWidth <= 4096 && image.naturalHeight <= 4096
            ? resolve()
            : reject(new Error('Logo 的宽度和高度均不能超过 4096 像素。'));
        image.onerror = () => reject(new Error('图片无法打开，请选择有效的 PNG 或 JPG 文件。'));
        image.src = source;
      });
      onChange({
        ...design,
        logo: {
          name: file.name,
          contentType: file.type as 'image/png' | 'image/jpeg',
          contentBase64: source.slice(source.indexOf(',') + 1),
        },
      });
    } catch (reason) {
      setLogoError(reason instanceof Error ? reason.message : '图片上传失败，请重试。');
    } finally {
      setLoadingLogo(false);
      onUploadingChange(false);
    }
  }
  return (
    <section className="mail-signature-designer" aria-label="邮件签名设计">
      <div className="mail-signature-fields">
        {design ? (
          <>
            <label>
              结束语
              <input
                value={design.closing}
                maxLength={160}
                disabled={disabled}
                onChange={(event) => onChange({ ...design, closing: event.target.value })}
              />
            </label>
            <label>
              公司名称
              <input
                value={design.companyName}
                maxLength={160}
                disabled={disabled}
                placeholder="Shuangsheng Shutter"
                onChange={(event) => onChange({ ...design, companyName: event.target.value })}
              />
            </label>
            <label>
              公司地址
              <textarea
                value={design.address}
                rows={2}
                maxLength={1000}
                disabled={disabled}
                placeholder="Dongguan City, Guangdong Province, China 523000"
                onChange={(event) => onChange({ ...design, address: event.target.value })}
              />
            </label>
            <label>
              公司官网
              <input
                type="url"
                value={design.website}
                maxLength={2000}
                disabled={disabled}
                placeholder="https://shuangshengshutter.com"
                onChange={(event) => onChange({ ...design, website: event.target.value })}
              />
            </label>
            <div className="mail-signature-logo">
              <span className="outreach-field-label">公司 Logo</span>
              <label className="btn secondary mail-signature-upload">
                <Upload size={15} />
                {loadingLogo ? '读取图片中…' : design.logo ? '替换 Logo' : '上传 Logo'}
                <input
                  type="file"
                  accept="image/png,image/jpeg"
                  disabled={disabled || loadingLogo}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = '';
                    if (file) void upload(file);
                  }}
                />
              </label>
              {design.logo && (
                <button
                  type="button"
                  className="btn subtle"
                  disabled={disabled || loadingLogo}
                  onClick={() => onChange({ ...design, logo: null })}
                >
                  <X size={14} />
                  删除 Logo
                </button>
              )}
              <small>PNG / JPG，最大 256 KB，尺寸不超过 4096 像素，保持原始比例。</small>
              {logoError && (
                <small role="alert" className="mail-signature-error">
                  {logoError}
                </small>
              )}
              {design.logo && (
                <label>
                  显示宽度：{design.logoWidth} px
                  <input
                    type="range"
                    min="80"
                    max="320"
                    step="10"
                    value={design.logoWidth}
                    disabled={disabled || loadingLogo}
                    onChange={(event) =>
                      onChange({ ...design, logoWidth: Number(event.target.value) })
                    }
                  />
                </label>
              )}
            </div>
            <small>姓名和邮箱自动使用此账号资料。保存后用于新邮件；待发送样稿需重新核对。</small>
          </>
        ) : (
          <>
            <label>
              现有纯文本签名
              <textarea
                value={signature}
                rows={6}
                maxLength={8000}
                disabled={disabled}
                onChange={(event) => onLegacyChange(event.target.value)}
              />
            </label>
            <small>使用表单设计后，将在保存时替换此签名。</small>
            <button
              type="button"
              className="btn secondary"
              disabled={disabled}
              onClick={() => onChange(defaultSignatureDesign(defaultCompany, defaultWebsite))}
            >
              使用表单设计签名
            </button>
          </>
        )}
      </div>
      <div className="mail-signature-preview-column">
        <span className="outreach-field-label">签名实时预览</span>
        <div
          className="mail-signature-preview"
          aria-label="签名预览"
          dangerouslySetInnerHTML={{ __html: preview.html }}
        />
        {!preview.text && (
          <p className="outreach-hint">填写业务员和公司资料后，签名会显示在这里。</p>
        )}
      </div>
    </section>
  );
}
