import githubIcon from "../assets/provider-icons/github.svg";
import gitlabIcon from "../assets/provider-icons/gitlab.svg";
import geelibIcon from "../assets/provider-icons/geelib.svg";

export type ProviderIconName = "github" | "gitlab" | "geelib";

type ProviderIconProps = {
  provider: ProviderIconName;
  size?: number;
  className?: string;
};

const providerLabels: Record<ProviderIconName, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  geelib: "Geelib",
};

const providerAssets: Record<ProviderIconName, string> = {
  github: githubIcon,
  gitlab: gitlabIcon,
  geelib: geelibIcon,
};

export function ProviderIcon({ provider, size = 14, className }: ProviderIconProps) {
  return <img className={`provider-icon${className ? ` ${className}` : ""}`} src={providerAssets[provider]} width={size} height={size} alt={providerLabels[provider]} aria-label={providerLabels[provider]} title={providerLabels[provider]} />;
}
