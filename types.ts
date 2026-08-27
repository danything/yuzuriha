/** 地図が読む共通の物件データ。取得元ごとの差はここに吸収する */
export type MapProperty = {
	/** 取得元をまたいで一意にするため "zero:960160" のように前置する */
	id: string;
	source: string;
	url: string;
	title: string;
	status: string;
	type: string;
	prefecture: string;
	city: string;
	region: string;
	address: string;
	lat: number;
	lng: number;
	/** 円。0円前提のサイトでも1円掲載などがあるので数値で持つ */
	price: number;
	builtYear: string | null;
	views: number;
	favorites: number;
	notes: string[];
	publishedAt: string;
	/** 絶対 URL か、imageBase からの相対パス */
	image: string | null;
	/** 座標を住所から推定した場合、一致した住所。掲載元の座標を使ったときは null */
	approx: string | null;
};
