import githubIcon from "../assets/provider-icons/github.svg";
import gitlabIcon from "../assets/provider-icons/gitlab.svg";

export type ProviderIconName = "github" | "gitlab";

type ProviderIconProps = {
  provider: ProviderIconName;
  size?: number;
  className?: string;
};

const providerLabels: Record<ProviderIconName, string> = {
  github: "GitHub",
  gitlab: "GitLab",
};

const providerAssets: Record<ProviderIconName, string> = {
  github: githubIcon,
  gitlab: gitlabIcon,
};

export function ProviderIcon({ provider, size = 14, className }: ProviderIconProps) {
  return <img className={`provider-icon${className ? ` ${className}` : ""}`} src={providerAssets[provider]} width={size} height={size} alt={providerLabels[provider]} aria-label={providerLabels[provider]} title={providerLabels[provider]} />;
}
