import {BookOpen,BriefcaseBusiness,ChartNoAxesCombined,CodeXml,FlaskConical,FolderClosed,Lightbulb,Palette} from 'lucide-react';
import type {ProjectColor,ProjectIcon} from '../types';

export const projectIcons={folder:{label:'文件夹',Icon:FolderClosed},briefcase:{label:'公文包',Icon:BriefcaseBusiness},flask:{label:'研发',Icon:FlaskConical},
  chart:{label:'图表',Icon:ChartNoAxesCombined},code:{label:'代码',Icon:CodeXml},book:{label:'书本',Icon:BookOpen},lightbulb:{label:'灵感',Icon:Lightbulb},palette:{label:'创意',Icon:Palette}};
export const projectColors:Record<ProjectColor,string>={blue:'蓝色',green:'绿色',amber:'琥珀色',violet:'紫色',rose:'玫红',slate:'灰色'};

export function ProjectMark({icon='folder',color='blue',size=14}: {icon?:ProjectIcon;color?:ProjectColor;size?:number}) {
  const Icon=projectIcons[icon]?.Icon??FolderClosed;
  return <span className={`project-mark project-mark--${color}`} aria-hidden="true"><Icon size={size}/></span>;
}
