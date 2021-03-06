import * as TypeORM from "typeorm";
import Model from "./common";

declare var syzoj: any;

import JudgeState from "./judge_state";
import UserPrivilege from "./user_privilege";
import Article from "./article";
import File from "./file";

import * as fs from "fs-extra";
import * as path from "path";
import * as util from "util";

@TypeORM.Entity()
export default class User extends Model {
  static cache = true;

  @TypeORM.PrimaryGeneratedColumn()
  id: number;

  @TypeORM.Index({ unique: true })
  @TypeORM.Column({ nullable: true, type: "varchar", length: 80 })
  username: string;

  @TypeORM.Column({ nullable: true, type: "varchar", length: 120 })
  email: string;

  @TypeORM.Column({ nullable: true, type: "varchar", length: 120 })
  password: string;

  @TypeORM.Column({ nullable: true, type: "varchar", length: 120 })
  token: string;

  @TypeORM.Column({ nullable: true, type: "varchar", length: 80 })
  nickname: string;

  @TypeORM.Column({ nullable: true, type: "text" })
  nameplate: string;

  @TypeORM.Column({ nullable: true, type: "text" })
  information: string;

  @TypeORM.Index()
  @TypeORM.Column({ nullable: true, type: "integer" })
  ac_num: number;

  @TypeORM.Index()
  @TypeORM.Column({ nullable: true, type: "integer" })
  submit_num: number;

  @TypeORM.Column({ nullable: true, type: "boolean" })
  is_admin: boolean;

  @TypeORM.Index()
  @TypeORM.Column({ nullable: true, type: "boolean" })
  is_show: boolean;

  @TypeORM.Column({ nullable: true, type: "boolean", default: true })
  public_email: boolean;

  @TypeORM.Column({ nullable: true, type: "boolean", default: false })
  prefer_dark_mode: boolean;

  @TypeORM.Column({ nullable: true, type: "integer" })
  sex: number;

  @TypeORM.Column({ nullable: true, type: "integer" })
  rating: number;

  @TypeORM.Column({ nullable: true, type: "integer" })
  register_time: number;

  @TypeORM.Column({ nullable: false, default: true, type: "boolean" })
  is_banned: boolean;

  upload_files: File[];

  async loadRelationships() {
    this.upload_files = await File.find({
      where: {
        type: `upload-by-user-${this.id}`
      }
    })
  }

  getFilePath() {
    return syzoj.utils.resolvePath(syzoj.config.upload_dir, 'user-upload', this.id.toString());
  }

  async listFile() {
    try {
      let dir = this.getFilePath();
      let filenameList = await fs.readdir(dir);
      let list = await Promise.all(filenameList.map(async x => {
        let stat = await fs.stat(path.join(dir, x));
        if (!stat.isFile()) return undefined;
        return {
          filename: x,
          size: stat.size
        };
      }));

      list = list.filter(x => x);

      let res = {
        files: list,
        zip: null
      };

      return res;
    } catch (e) {
      return null;
    }
  }

  async uploadSingleFile(filename, filepath, size, noLimit) {
    await syzoj.utils.lock(['Promise::Userfile', this.id], async () => {
      let dir = this.getFilePath();
      await fs.ensureDir(dir);

      let oldSize = 0, list = await this.listFile(), replace = false, oldCount = 0;
      if (list) {
        oldCount = list.files.length;
        for (let file of list.files) {
          if (file.filename !== filename) oldSize += file.size;
          else replace = true;
        }
      }

      await fs.move(filepath, path.join(dir, filename), { overwrite: true });

      let execFileAsync = util.promisify(require('child_process').execFile);
      try { await execFileAsync('dos2unix', [path.join(dir, filename)]); } catch (e) { }
    });
  }

  async deleteSingleFile(filename) {
    await syzoj.utils.lock(['Promise::Userfile', this.id], async () => {
      await fs.remove(path.join(this.getFilePath(), filename));
    });
  }

  static async fromEmail(email): Promise<User> {
    return User.findOne({
      where: {
        email: email
      }
    });
  }

  static async fromName(name): Promise<User> {
    return User.findOne({
      where: {
        username: name
      }
    });
  }

  async isAllowedEditBy(user) {
    if (!user) return false;
    if (await user.hasPrivilege('manage_user')) return true;
    return user && (user.is_admin || this.id === user.id);
  }

  getQueryBuilderForACProblems() {
    return JudgeState.createQueryBuilder()
      .select(`DISTINCT(problem_id)`)
      .where('user_id = :user_id', { user_id: this.id })
      .andWhere('status = :status', { status: 'Accepted' })
      .andWhere('type != 1')
      .orderBy({ problem_id: 'ASC' })
  }

  async refreshSubmitInfo() {
    await syzoj.utils.lock(['User::refreshSubmitInfo', this.id], async () => {
      this.ac_num = await JudgeState.countQuery(this.getQueryBuilderForACProblems());
      this.submit_num = await JudgeState.count({
        user_id: this.id,
        type: TypeORM.Not(1) // Not a contest submission
      });

      await this.save();
    });
  }

  async getACProblems() {
    let queryResult = await this.getQueryBuilderForACProblems().getRawMany();

    return queryResult.map(record => record['problem_id'])
  }

  async getArticles() {
    return await Article.find({
      where: {
        user_id: this.id
      }
    });
  }

  async getStatistics() {
    let statuses = {
      "Accepted": ["Accepted"],
      "Wrong Answer": ["Wrong Answer", "File Error", "Output Limit Exceeded"],
      "Runtime Error": ["Runtime Error"],
      "Time Limit Exceeded": ["Time Limit Exceeded"],
      "Memory Limit Exceeded": ["Memory Limit Exceeded"],
      "Compile Error": ["Compile Error"]
    };

    let res = {};
    for (let status in statuses) {
      res[status] = 0;
      for (let s of statuses[status]) {
        res[status] += await JudgeState.count({
          user_id: this.id,
          type: 0,
          status: s
        });
      }
    }

    return res;
  }

  async renderInformation() {
    this.information = await syzoj.utils.markdown(this.information);
  }

  async getPrivileges() {
    let privileges = await UserPrivilege.find({
      where: {
        user_id: this.id
      }
    });

    return privileges.map(x => x.privilege);
  }
  async destroy() {
    const id = (this as any).id;
    await TypeORM.getManager().remove(this);
    await (this.constructor as typeof Model).deleteFromCache(id);
  }
  async setPrivileges(newPrivileges) {
    let oldPrivileges = await this.getPrivileges();

    let delPrivileges = oldPrivileges.filter(x => !newPrivileges.includes(x));
    let addPrivileges = newPrivileges.filter(x => !oldPrivileges.includes(x));

    for (let privilege of delPrivileges) {
      let obj = await UserPrivilege.findOne({
        where: {
          user_id: this.id,
          privilege: privilege
        }
      });

      await obj.destroy();
    }

    for (let privilege of addPrivileges) {
      let obj = await UserPrivilege.create({
        user_id: this.id,
        privilege: privilege
      });

      await obj.save();
    }
  }

  async hasPrivilege(privilege) {
    if (this.is_admin) return true;

    let x = await UserPrivilege.findOne({ where: { user_id: this.id, privilege: privilege } });
    return !!x;
  }

  async getLastSubmitLanguage() {
    let a = await JudgeState.findOne({
      where: {
        user_id: this.id
      },
      order: {
        submit_time: 'DESC'
      }
    });
    if (a) return a.language;

    return null;
  }
}
